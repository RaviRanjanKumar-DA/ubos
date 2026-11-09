package app.ubos.mobile

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.Editable
import android.text.TextWatcher
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView
import app.ubos.mobile.Ui.column
import app.ubos.mobile.Ui.dp
import app.ubos.mobile.Ui.gap
import app.ubos.mobile.Ui.input
import app.ubos.mobile.Ui.label
import app.ubos.mobile.Ui.outline
import app.ubos.mobile.Ui.primary
import app.ubos.mobile.Ui.round
import app.ubos.mobile.Ui.row
import app.ubos.mobile.Ui.show
import org.json.JSONObject
import kotlin.concurrent.thread

/** My leads: today's follow-ups first, tap to call with the SIM. */
class MainActivity : Activity() {
    private lateinit var store: Store
    private lateinit var queue: Queue
    private lateinit var status: TextView
    private lateinit var banner: View
    private lateinit var search: android.widget.EditText
    private var today = true
    private var rows: List<JSONObject> = emptyList()
    private val adapter = LeadAdapter()
    private val handler = Handler(Looper.getMainLooper())
    private val tick = object : Runnable { override fun run() { refresh(); handler.postDelayed(this, 10_000) } }
    private lateinit var tabToday: TextView
    private lateinit var tabAll: TextView

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        store = Store(this); queue = Queue(this)
        if (store.token == null) { startActivity(Intent(this, PairActivity::class.java)); finish(); return }
        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val head = column(16).apply { setBackgroundColor(Ui.brand) }
        val top = row()
        top.addView(label(store.organization.ifEmpty { "UBOS" }, 18f, Color.WHITE, true), LinearLayout.LayoutParams(0, -2, 1f))
        top.addView(label("Disconnect", 13f, Color.WHITE).apply { setPadding(dp(8), dp(4), 0, dp(4)); setOnClickListener { confirmUnpair() } })
        head.addView(top)
        status = label("", 13f, Color.parseColor("#E4DEFA"))
        head.addView(gap(status, 2))
        root.addView(head)
        banner = outline("Allow calling and call log") { askPermissions() }
        root.addView(banner, Ui.lp().apply { setMargins(dp(12), dp(10), dp(12), 0) })
        val tabs = row().apply { setPadding(dp(12), dp(10), dp(12), 0) }
        tabToday = tab("Today") { today = true; render() }
        tabAll = tab("All leads") { today = false; render() }
        tabs.addView(tabToday, LinearLayout.LayoutParams(0, dp(40), 1f)); tabs.addView(tabAll, LinearLayout.LayoutParams(0, dp(40), 1f).apply { leftMargin = dp(8) })
        root.addView(tabs)
        search = input("Search name or number")
        search.addTextChangedListener(object : TextWatcher { override fun afterTextChanged(s: Editable?) { render() }; override fun beforeTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {}; override fun onTextChanged(s: CharSequence?, a: Int, b: Int, c: Int) {} })
        root.addView(search, Ui.lp().apply { setMargins(dp(12), dp(8), dp(12), dp(4)) })
        val list = ListView(this).apply { adapter = this@MainActivity.adapter; divider = null; clipToPadding = false; setPadding(dp(12), dp(4), dp(12), dp(16)); emptyView = null }
        root.addView(list, LinearLayout.LayoutParams(-1, 0, 1f))
        show(root)
        askPermissions()
        intent.getStringExtra("dial")?.let { placeCall(it, "") }
    }

    private fun tab(s: String, click: () -> Unit) = label(s, 14f, Ui.ink, true).apply { gravity = android.view.Gravity.CENTER; setOnClickListener { click() } }

    private fun confirmUnpair() {
        android.app.AlertDialog.Builder(this).setTitle("Disconnect this phone?").setMessage("Calls stop reaching UBOS until you connect again.").setNegativeButton("Go back", null)
            .setPositiveButton("Disconnect") { _, _ -> store.unpair(); startActivity(Intent(this, PairActivity::class.java)); finish() }.show()
    }

    private val needed: Array<String> get() = buildList {
        add(Manifest.permission.CALL_PHONE); add(Manifest.permission.READ_CALL_LOG); add(Manifest.permission.READ_PHONE_STATE)
        if (Build.VERSION.SDK_INT >= 33) { add(Manifest.permission.POST_NOTIFICATIONS); add(Manifest.permission.READ_MEDIA_AUDIO) } else add(Manifest.permission.READ_EXTERNAL_STORAGE)
    }.toTypedArray()
    private fun askPermissions() { val m = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }; if (m.isNotEmpty()) requestPermissions(m.toTypedArray(), 1) }
    private fun updateBanner() { banner.visibility = if (checkSelfPermission(Manifest.permission.CALL_PHONE) == PackageManager.PERMISSION_GRANTED && checkSelfPermission(Manifest.permission.READ_CALL_LOG) == PackageManager.PERMISSION_GRANTED) View.GONE else View.VISIBLE }
    override fun onRequestPermissionsResult(c: Int, p: Array<out String>, g: IntArray) { updateBanner(); refresh() }

    override fun onResume() { super.onResume(); front = true; opening = false; if (store.token == null) { startActivity(Intent(this, PairActivity::class.java)); finish(); return }; updateBanner(); load(); handler.post(tick) }
    override fun onPause() { super.onPause(); front = false; handler.removeCallbacks(tick) }

    private fun refresh() {
        thread {
            var problem: String? = null
            var dial: org.json.JSONArray? = null
            val sync = Sync(this)
            try { dial = sync.all() }
            catch (e: ApiError) { problem = e.message; if (e.code == "DEVICE_REVOKED") { runOnUiThread { startActivity(Intent(this, PairActivity::class.java)); finish() }; return@thread } }
            catch (_: Exception) { problem = "No connection. Calls are saved on this phone." }
            runOnUiThread {
                if (!front) return@runOnUiThread // a pass that finished after another screen opened
                load(problem)
                val next = queue.nextOutcome()
                if (next != null && !opening) { opening = true; startActivity(Intent(this, OutcomeActivity::class.java).putExtra("id", next.externalId)) }
                else if (dial != null && dial!!.length() > 0) { val d = dial!!.getJSONObject(0); placeCall(d.getString("number"), d.optString("leadId")) }
            }
        }
    }
    private var opening = false
    private var front = false

    private fun load(problem: String? = null) {
        val s = store.loadSync()
        val waiting = queue.waitingCount()
        status.text = "${store.userName} · " + (problem ?: if (waiting > 0) "$waiting ${if (waiting == 1) "call" else "calls"} waiting to sync" else if (store.lastSync > 0) "Synced ${Ist.time(store.lastSync)}" else "Syncing…")
        val a = s?.optJSONArray("leads")
        rows = if (a == null) emptyList() else (0 until a.length()).map { a.getJSONObject(it) }
        render()
    }

    private fun dueAt(l: JSONObject) = if (l.isNull("nextFollowUpAt")) null else Ist.parse(l.optString("nextFollowUpAt"))

    private fun render() {
        fun style(v: TextView, on: Boolean) { v.background = round(if (on) Ui.brand else Color.WHITE, 10, if (on) null else Ui.line); v.setTextColor(if (on) Color.WHITE else Ui.ink) }
        style(tabToday, today); style(tabAll, !today)
        val q = search.text.toString().trim().lowercase()
        val end = Ist.endOfToday(System.currentTimeMillis())
        adapter.items = rows.filter { l ->
            (!today || (dueAt(l)?.let { it <= end } ?: false)) && (q.isEmpty() || l.optString("name").lowercase().contains(q) || l.optString("phoneDisplay").contains(q))
        }
        adapter.notifyDataSetChanged()
    }

    private fun placeCall(number: String, leadId: String) {
        if (checkSelfPermission(Manifest.permission.CALL_PHONE) != PackageManager.PERMISSION_GRANTED) { askPermissions(); return }
        store.dialNumber = Phones.key(number); store.dialLead = leadId
        startActivity(Intent(Intent.ACTION_CALL, Uri.parse("tel:$number")))
    }

    inner class LeadAdapter : BaseAdapter() {
        var items: List<JSONObject> = emptyList()
        override fun getCount() = items.size + (if (items.isEmpty()) 1 else 0)
        override fun getItem(p: Int) = items.getOrNull(p)
        override fun getItemId(p: Int) = p.toLong()
        override fun getView(p: Int, old: View?, parent: ViewGroup): View {
            val c = this@MainActivity
            if (items.isEmpty()) return c.label(if (today) "No follow-ups due today." else "No leads yet.", 14f, Ui.muted).apply { gravity = android.view.Gravity.CENTER; setPadding(0, c.dp(40), 0, 0) }
            val l = items[p]
            val card = c.row().apply { background = c.round(Color.WHITE, 12, Ui.line); setPadding(c.dp(14), c.dp(12), c.dp(10), c.dp(12)) }
            val text = LinearLayout(c).apply { orientation = LinearLayout.VERTICAL }
            text.addView(c.label(l.optString("name"), 16f, Ui.ink, true).apply { maxLines = 1 })
            val sub = listOf(l.optString("phoneDisplay").takeIf { it != "null" && it.isNotEmpty() }, l.optString("stage").takeIf { it != "null" && it.isNotEmpty() }).filterNotNull().joinToString(" · ")
            text.addView(c.label(sub, 13f, Ui.muted).apply { maxLines = 1 })
            dueAt(l)?.let { d -> val late = d < System.currentTimeMillis(); text.addView(c.label((if (late) "Overdue: " else "Follow-up: ") + Ist.dateTime(d), 13f, if (late) Ui.bad else Ui.brand)) }
            card.addView(text, LinearLayout.LayoutParams(0, -2, 1f))
            val num = l.optString("dialNumber")
            if (num.isNotEmpty() && num != "null") card.addView(c.primary("Call") { placeCall(num, l.getString("id")) }, LinearLayout.LayoutParams(c.dp(76), c.dp(44)))
            return LinearLayout(c).apply { orientation = LinearLayout.VERTICAL; setPadding(0, 0, 0, c.dp(8)); addView(card) }
        }
    }
}
