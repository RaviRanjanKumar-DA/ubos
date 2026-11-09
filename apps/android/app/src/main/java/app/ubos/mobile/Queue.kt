package app.ubos.mobile

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import org.json.JSONObject

data class QCall(
    val externalId: String, val leadId: String?, val number: String, val direction: String, val startedAt: Long, val talkSec: Int, val answered: Boolean,
    val disposition: String?, val remark: String?, val followUpAt: Long?, val updatedAt: Long?, val needsOutcome: Boolean, val recState: String?,
)

/** Calls waiting to reach UBOS. Survives restarts; a call stays here until the server has confirmed it. */
class Queue(ctx: Context) : SQLiteOpenHelper(ctx, "queue.db", null, 1) {
    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE calls (externalId TEXT PRIMARY KEY, leadId TEXT, number TEXT NOT NULL, direction TEXT NOT NULL, startedAt INTEGER NOT NULL, talkSec INTEGER NOT NULL, answered INTEGER NOT NULL, disposition TEXT, remark TEXT, followUpAt INTEGER, updatedAt INTEGER, needsOutcome INTEGER NOT NULL DEFAULT 0, synced INTEGER NOT NULL DEFAULT 0, error TEXT, recState TEXT)")
        db.execSQL("CREATE INDEX calls_synced ON calls(synced, startedAt)")
    }
    override fun onUpgrade(db: SQLiteDatabase, a: Int, b: Int) {}

    /** The same call-log entry can be read many times; only the first is kept. Returns true if it is new. */
    fun add(c: QCall): Boolean = writableDatabase.insertWithOnConflict("calls", null, ContentValues().apply {
        put("externalId", c.externalId); put("leadId", c.leadId); put("number", c.number); put("direction", c.direction); put("startedAt", c.startedAt)
        put("talkSec", c.talkSec); put("answered", if (c.answered) 1 else 0); put("needsOutcome", if (c.needsOutcome) 1 else 0)
    }, SQLiteDatabase.CONFLICT_IGNORE) != -1L

    private fun list(where: String, args: Array<String>, order: String, limit: Int): List<QCall> {
        val out = ArrayList<QCall>()
        readableDatabase.query("calls", null, where, args, null, null, order, limit.toString()).use { r ->
            fun s(n: String) = r.getColumnIndexOrThrow(n).let { if (r.isNull(it)) null else r.getString(it) }
            fun l(n: String) = r.getColumnIndexOrThrow(n).let { if (r.isNull(it)) null else r.getLong(it) }
            while (r.moveToNext()) out += QCall(s("externalId")!!, s("leadId"), s("number")!!, s("direction")!!, l("startedAt")!!, l("talkSec")!!.toInt(), l("answered") == 1L, s("disposition"), s("remark"), l("followUpAt"), l("updatedAt"), l("needsOutcome") == 1L, s("recState"))
        }
        return out
    }
    fun unsynced(limit: Int) = list("synced = 0", emptyArray(), "startedAt ASC", limit)
    fun waitingCount(): Int = readableDatabase.rawQuery("SELECT COUNT(*) FROM calls WHERE synced = 0", null).use { it.moveToFirst(); it.getInt(0) }
    fun nextOutcome(): QCall? = list("needsOutcome = 1", emptyArray(), "startedAt DESC", 1).firstOrNull()
    fun get(id: String): QCall? = list("externalId = ?", arrayOf(id), "startedAt DESC", 1).firstOrNull()
    fun knownSince(since: Long): List<String> = list("startedAt >= ?", arrayOf(since.toString()), "startedAt DESC", 5000).map { it.externalId }
    fun recordingDue(since: Long) = list("synced = 1 AND talkSec > 0 AND recState IS NULL AND startedAt >= ?", arrayOf(since.toString()), "startedAt ASC", 10)

    /** Media files already sent, so one recording can never be attached to two calls. */
    fun usedRecordings(): Set<String> = readableDatabase.rawQuery("SELECT recState FROM calls WHERE recState LIKE 'media:%'", null).use { r -> buildSet { while (r.moveToNext()) add(r.getString(0)) } }
    fun markSynced(id: String) = set(id, ContentValues().apply { put("synced", 1); putNull("error") })
    fun markRejected(id: String, why: String) = set(id, ContentValues().apply { put("synced", 2); put("error", why) })
    fun markMissing(id: String) = set(id, ContentValues().apply { put("synced", 0) })
    fun setRec(id: String, state: String) = set(id, ContentValues().apply { put("recState", state) })
    fun saveOutcome(id: String, disposition: String?, remark: String?, followUpAt: Long?, now: Long) = set(id, ContentValues().apply {
        put("disposition", disposition); put("remark", remark); put("followUpAt", followUpAt); put("updatedAt", now); put("needsOutcome", 0); put("synced", 0)
    })
    fun skipOutcome(id: String) = set(id, ContentValues().apply { put("needsOutcome", 0) })
    fun clear() { writableDatabase.delete("calls", null, null) }
    private fun set(id: String, v: ContentValues) { writableDatabase.update("calls", v, "externalId = ?", arrayOf(id)) }

    fun toJson(c: QCall) = JSONObject().apply {
        put("externalId", c.externalId); put("number", c.number); put("direction", c.direction); put("startedAt", Ist.iso(c.startedAt)); put("talkSec", c.talkSec); put("answered", c.answered)
        if (c.leadId != null) put("leadId", c.leadId)
        if (c.disposition != null) put("disposition", c.disposition)
        if (c.remark != null) put("remark", c.remark)
        if (c.followUpAt != null) put("followUpAt", Ist.iso(c.followUpAt))
        if (c.updatedAt != null) put("updatedAt", Ist.iso(c.updatedAt))
    }
}
