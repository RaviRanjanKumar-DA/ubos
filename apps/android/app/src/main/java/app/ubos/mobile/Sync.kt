package app.ubos.mobile

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ContentUris
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.provider.CallLog
import android.provider.MediaStore
import org.json.JSONArray
import org.json.JSONObject

private data class Recording(val uri: android.net.Uri, val size: Long, val mime: String, val mark: String)

/** Everything that moves data between the phone and UBOS. Safe to run repeatedly. */
class Sync(private val ctx: Context) {
    private val store = Store(ctx)
    private val queue = Queue(ctx)
    private fun has(p: String) = ctx.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED

    private inline fun <T> authed(fn: (String) -> T): T {
        val t = store.token ?: throw ApiError(401, "NOT_PAIRED", "This phone is not paired")
        try { return fn(t) } catch (e: ApiError) {
            if (e.code == "DEVICE_REVOKED") store.unpair()
            throw e
        }
    }

    /** Leads, follow-ups, outcomes, and calls requested from the web. Returns the numbers to dial. */
    fun down(): JSONArray = authed { t ->
        val j = Api.json(store.server, "/mobile/v1/sync", "GET", t)
        store.saveSync(j)
        store.lastSync = System.currentTimeMillis()
        j.optJSONArray("dial") ?: JSONArray()
    }

    /** Reads the phone's call log. Only calls with known leads are kept, unless the organization also wants unknown callers. */
    fun capture(windowMs: Long = 48 * 3_600_000L): Int {
        if (!has(Manifest.permission.READ_CALL_LOG) || store.deviceId.isEmpty() || store.token == null) return 0
        val sync = store.loadSync() ?: return 0
        val leads = HashMap<String, String>()
        sync.optJSONArray("leads")?.let { a -> for (i in 0 until a.length()) { val l = a.getJSONObject(i); val k = Phones.key(l.optString("dialNumber")); if (k.isNotEmpty()) leads[k] = l.getString("id") } }
        val unknownToo = sync.optBoolean("captureUnknown", false)
        val now = System.currentTimeMillis()
        var added = 0
        ctx.contentResolver.query(CallLog.Calls.CONTENT_URI, arrayOf(CallLog.Calls._ID, CallLog.Calls.NUMBER, CallLog.Calls.TYPE, CallLog.Calls.DATE, CallLog.Calls.DURATION), "${CallLog.Calls.DATE} > ?", arrayOf(maxOf(now - windowMs, store.pairedAt).toString()), "${CallLog.Calls.DATE} DESC")?.use { r ->
            while (r.moveToNext()) {
                val number = r.getString(1) ?: continue
                val key = Phones.key(number)
                if (key.length < 6) continue
                val dialed = store.dialNumber == key
                val leadId = if (dialed && store.dialLead.isNotEmpty()) store.dialLead else leads[key]
                val type = r.getInt(2)
                val outbound = type == CallLog.Calls.OUTGOING_TYPE
                if (leadId == null && (outbound || !unknownToo)) continue
                val start = r.getLong(3)
                val talk = r.getInt(4)
                val isNew = queue.add(QCall(Phones.externalId(store.installId, r.getLong(0), start), leadId, number, if (outbound) "outbound" else "inbound", start, talk, talk > 0, null, null, null, null, leadId != null && now - start < 30 * 60_000L, null))
                if (isNew) added++
            }
        }
        return added
    }

    /** Sends waiting calls. A call leaves the queue only when the server has answered for it. */
    fun flush() = authed { t ->
        while (true) {
            val batch = queue.unsynced(50)
            if (batch.isEmpty()) break
            val arr = JSONArray().also { a -> batch.forEach { a.put(queue.toJson(it)) } }
            val res = Api.json(store.server, "/mobile/v1/calls", "POST", t, JSONObject().put("calls", arr).put("pending", queue.waitingCount())).getJSONArray("results")
            for (i in 0 until res.length()) {
                val r = res.getJSONObject(i)
                val id = r.getString("externalId")
                if (r.getString("status") == "rejected") queue.markRejected(id, r.optString("error", "Rejected")) else queue.markSynced(id)
            }
        }
    }

    /** Sends the keys of the last 48 hours; anything the server does not have goes out again. */
    fun reconcile() = authed { t ->
        val since = System.currentTimeMillis() - 48 * 3_600_000L
        val ids = queue.knownSince(since)
        if (ids.isNotEmpty()) {
            val body = JSONObject().put("since", Ist.iso(since)).put("externalIds", JSONArray(ids))
            val missing = Api.json(store.server, "/mobile/v1/calls/reconcile", "POST", t, body).getJSONArray("missing")
            for (i in 0 until missing.length()) queue.markMissing(missing.getString(i))
        }
    }

    private fun recordingFor(c: QCall): Recording? {
        val perm = if (Build.VERSION.SDK_INT >= 33) Manifest.permission.READ_MEDIA_AUDIO else Manifest.permission.READ_EXTERNAL_STORAGE
        if (!has(perm)) return null
        val from = c.startedAt / 1000
        val used = queue.usedRecordings()
        val to = (c.startedAt + c.talkSec * 1000L) / 1000 + 120
        val uri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
        val key = Phones.key(c.number)
        ctx.contentResolver.query(uri, arrayOf(MediaStore.Audio.Media._ID, MediaStore.Audio.Media.DISPLAY_NAME, MediaStore.Audio.Media.SIZE, MediaStore.Audio.Media.MIME_TYPE, MediaStore.Audio.Media.RELATIVE_PATH, MediaStore.Audio.Media.DATE_ADDED), "${MediaStore.Audio.Media.DATE_ADDED} BETWEEN ? AND ?", arrayOf(from.toString(), to.toString()), "${MediaStore.Audio.Media.DATE_ADDED} ASC")?.use { r ->
            while (r.moveToNext()) {
                val name = r.getString(1) ?: ""
                val dir = (r.getString(4) ?: "").lowercase()
                // Only the phone's own call recordings: a file in a call folder, or one named after this number.
                if (!(dir.contains("call") || Phones.key(name).endsWith(key))) continue
                val mark = "media:${r.getLong(0)}"
                if (mark in used) continue
                return Recording(ContentUris.withAppendedId(uri, r.getLong(0)), r.getLong(2), r.getString(3) ?: "audio/mpeg", mark)
            }
        }
        return null
    }

    /** Uploads in pieces and resumes from what the server already has. A file too large or not found is left alone. */
    fun recordings() = authed { t ->
        val now = System.currentTimeMillis()
        for (c in queue.recordingDue(now - 24 * 3_600_000L)) {
            val found = recordingFor(c)
            if (found == null) { if (now - c.startedAt > 30 * 60_000L) queue.setRec(c.externalId, "none"); continue }
            val (uri, size, mime, mark) = found
            if (size <= 0 || size > 50L * 1024 * 1024) { queue.setRec(c.externalId, "skipped"); continue }
            val path = "/mobile/v1/calls/${java.net.URLEncoder.encode(c.externalId, "UTF-8")}/recording"
            var sent = Api.json(store.server, path, "GET", t).optLong("received", 0)
            ctx.contentResolver.openInputStream(uri)?.use { s ->
                var skip = sent
                while (skip > 0) { val n = s.skip(skip); if (n <= 0) break; skip -= n }
                val buf = ByteArray(1024 * 1024)
                while (sent < size) {
                    val n = s.read(buf)
                    if (n <= 0) break
                    sent = Api.putChunk(store.server, path, t, buf, n, sent, size, mime).optLong("received", sent + n)
                }
            }
            if (sent >= size) queue.setRec(c.externalId, mark)
        }
    }

    fun heartbeat() = authed { t -> Api.json(store.server, "/mobile/v1/heartbeat", "POST", t, JSONObject().put("appVersion", "0.1.0").put("pending", queue.waitingCount())) }

    /** One full pass, used by the background job. */
    fun all(): JSONArray {
        // The call log is read first, so calls are kept and outcomes asked for even with no network.
        capture()
        val dial = down()
        capture()
        flush()
        reconcile()
        flush()
        recordings()
        heartbeat()
        return dial
    }

    fun channel() {
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("calls", "Calls", NotificationManager.IMPORTANCE_HIGH))
    }

    fun notifyOutcome(c: QCall) {
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) return
        channel()
        val i = PendingIntent.getActivity(ctx, 1, Intent(ctx, OutcomeActivity::class.java).putExtra("id", c.externalId), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = android.app.Notification.Builder(ctx, "calls").setSmallIcon(R.drawable.ic_launcher).setContentTitle("How did the call go?").setContentText("Tap to save the outcome").setContentIntent(i).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify(1, n)
    }

    fun notifyDial(number: String, name: String) {
        if (Build.VERSION.SDK_INT >= 33 && !has(Manifest.permission.POST_NOTIFICATIONS)) return
        channel()
        val i = PendingIntent.getActivity(ctx, 2, Intent(ctx, MainActivity::class.java).putExtra("dial", number), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val n = android.app.Notification.Builder(ctx, "calls").setSmallIcon(R.drawable.ic_launcher).setContentTitle("Call $name").setContentText("Requested from UBOS. Tap to call.").setContentIntent(i).setAutoCancel(true).build()
        ctx.getSystemService(NotificationManager::class.java).notify(2, n)
    }
}
