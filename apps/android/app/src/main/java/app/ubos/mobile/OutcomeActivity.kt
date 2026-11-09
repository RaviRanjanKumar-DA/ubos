package app.ubos.mobile

import android.annotation.SuppressLint
import android.app.Activity
import android.app.DatePickerDialog
import android.app.TimePickerDialog
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.window.OnBackInvokedDispatcher
import android.widget.GridLayout
import android.widget.ScrollView
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

/** Shown after a call with a lead: the outcome, a remark and the next follow-up. */
class OutcomeActivity : Activity() {
    private var required = false
    private var saved = false
    private var picked: String? = null
    private var followUp: Long? = null

    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val queue = Queue(this)
        val store = Store(this)
        val call = intent.getStringExtra("id")?.let { queue.get(it) }
        if (call == null) { finish(); return }
        val sync = store.loadSync()
        val leadList = sync?.optJSONArray("leads")
        val lead: JSONObject? = leadList?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("id") == call.leadId } }
        required = sync?.optBoolean("dispositionRequired", false) ?: false
        val box = column(20)
        box.addView(label(lead?.optString("name") ?: call.number, 22f, Ui.ink, true))
        val mins = call.talkSec / 60; val secs = call.talkSec % 60
        box.addView(gap(label((if (call.direction == "outbound") "Outgoing" else "Incoming") + " · " + (if (call.answered) "${mins}m ${secs}s" else "Not answered") + " · " + Ist.dateTime(call.startedAt), 14f, Ui.muted), 2))
        sync?.optJSONArray("scripts")?.let { a ->
            (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("workspaceId") == lead?.optString("workspaceId") }?.let { s ->
                box.addView(gap(label(s.optString("body"), 14f, Ui.ink).apply { background = round(Ui.soft, 10); setPadding(dp(12), dp(10), dp(12), dp(10)) }, 12))
            }
        }
        box.addView(gap(label("What happened?", 15f, Ui.ink, true), 16))
        val grid = GridLayout(this).apply { columnCount = 2 }
        val chips = ArrayList<Pair<Button, String>>()
        fun paint() = chips.forEach { (v, value) -> val on = value == picked; v.background = round(if (on) Ui.brand else Color.WHITE, 10, if (on) null else Ui.line); v.setTextColor(if (on) Color.WHITE else Ui.ink) }
        val options = sync?.optJSONArray("dispositions")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.filter { it.optString("workspaceId") == lead?.optString("workspaceId") } } ?: emptyList()
        for (o in options) {
            val value = o.optString("value")
            val chip = Button(this).apply { text = o.optString("label"); isAllCaps = false; stateListAnimator = null; minHeight = dp(46); setOnClickListener { picked = value; paint() } }
            chips += chip to value
            grid.addView(chip, GridLayout.LayoutParams(GridLayout.spec(GridLayout.UNDEFINED), GridLayout.spec(GridLayout.UNDEFINED, 1f)).apply { width = 0; setMargins(dp(3), dp(3), dp(3), dp(3)) })
            if (!call.answered && o.optBoolean("isDefault") && !o.optBoolean("connected")) picked = value
        }
        paint()
        box.addView(gap(grid, 6))
        val remark = input("Remark (optional)", InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES)
        box.addView(gap(remark, 12))
        box.addView(gap(label("Next follow-up", 15f, Ui.ink, true), 14))
        val shown = label("None", 14f, Ui.muted)
        fun setFollow(v: Long?) { followUp = v; shown.text = if (v == null) "None" else Ist.dateTime(v) + " IST" }
        val quick = row()
        val now = System.currentTimeMillis()
        quick.addView(outline("Tomorrow") { setFollow(Ist.daysAhead(now, 1, 11)) }, android.widget.LinearLayout.LayoutParams(0, -2, 1f))
        quick.addView(outline("In 3 days") { setFollow(Ist.daysAhead(now, 3, 11)) }, android.widget.LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(6) })
        quick.addView(outline("Pick") {
            val c = java.util.Calendar.getInstance(Ist.zone)
            DatePickerDialog(this, { _, y, m, d -> TimePickerDialog(this, { _, h, min -> setFollow(Ist.at(y, m, d, h, min)) }, 11, 0, false).show() }, c.get(java.util.Calendar.YEAR), c.get(java.util.Calendar.MONTH), c.get(java.util.Calendar.DAY_OF_MONTH)).apply { datePicker.minDate = now - 1000 }.show()
        }, android.widget.LinearLayout.LayoutParams(0, -2, 1f).apply { leftMargin = dp(6) })
        box.addView(gap(quick, 6))
        box.addView(gap(shown, 6))
        val err = label("", 14f, Ui.bad)
        box.addView(gap(err, 8))
        box.addView(gap(primary("Save") {
            if (required && picked == null) { err.text = "Choose what happened."; return@primary }
            queue.saveOutcome(call.externalId, picked, remark.text.toString().trim().ifEmpty { null }, followUp, System.currentTimeMillis())
            saved = true
            thread { try { Sync(this).flush() } catch (_: Exception) { SyncJob.soon(this) } }
            finish()
        }, 6))
        if (!required) box.addView(gap(outline("Skip") { queue.skipOutcome(call.externalId); saved = true; finish() }, 8))
        show(ScrollView(this).apply { addView(box) })
        holdBack()
    }

    /** Android 13 and later use this for the back gesture; it stays registered until the outcome is saved. */
    private fun holdBack() {
        if (required && Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { }
    }

    @SuppressLint("GestureBackNavigation")
    @Deprecated("Used on Android 12 and older")
    override fun onBackPressed() { if (!required || saved) @Suppress("DEPRECATION") super.onBackPressed() }
}
