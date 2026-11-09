package app.ubos.mobile

import android.app.Activity
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.widget.ScrollView
import app.ubos.mobile.Ui.column
import app.ubos.mobile.Ui.dp
import app.ubos.mobile.Ui.gap
import app.ubos.mobile.Ui.input
import app.ubos.mobile.Ui.label
import app.ubos.mobile.Ui.primary
import app.ubos.mobile.Ui.round
import app.ubos.mobile.Ui.show
import org.json.JSONObject
import kotlin.concurrent.thread

/** Links this phone to one person, with the 6-digit code shown on the web under My Security. */
class PairActivity : Activity() {
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        val store = Store(this)
        val box = column(24)
        box.gravity = Gravity.CENTER_HORIZONTAL
        val brand = label("U", 26f, android.graphics.Color.WHITE, true).apply { gravity = Gravity.CENTER; background = round(Ui.brand, 14) }
        box.addView(brand, Ui.lp(dp(56), dp(56)))
        box.addView(gap(label("Connect this phone", 22f, Ui.ink, true).apply { gravity = Gravity.CENTER }, 14))
        box.addView(gap(label("In UBOS on your computer, open Calls, then My phone, and create a pairing code.", 14f, Ui.muted).apply { gravity = Gravity.CENTER }, 6))
        val server = input("Server address", InputType.TYPE_TEXT_VARIATION_URI or InputType.TYPE_CLASS_TEXT).apply { setText(store.server.ifEmpty { if ((applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) "http://10.0.2.2:4100" else "https://" }) }
        val org = input("Organization code").apply { setText(store.org); inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS }
        val code = input("6-digit pairing code", InputType.TYPE_CLASS_NUMBER)
        val err = label("", 14f, Ui.bad).apply { gravity = Gravity.CENTER }
        box.addView(gap(server, 20)); box.addView(gap(org, 10)); box.addView(gap(code, 10)); box.addView(gap(err, 10))
        lateinit var go: android.widget.Button
        go = primary("Connect") {
            err.text = ""
            val s = server.text.toString().trim(); val o = org.text.toString().trim().lowercase(); val c = code.text.toString().trim()
            if (s.length < 10 || o.length < 2 || c.length != 6) { err.text = "Fill in all three boxes."; return@primary }
            go.isEnabled = false; go.text = "Connecting…"
            thread {
                try {
                    val r = Api.json(s, "/mobile/v1/pair", "POST", null, JSONObject().put("org", o).put("code", c).put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}".take(60)).put("platform", "android").put("appVersion", "0.1.0"))
                    val who = r.getJSONObject("user")
                    // Calls waiting from a previous person on this phone must not go out under the new person.
                    if (store.userId.isNotEmpty() && store.userId != who.getString("id")) Queue(this).clear()
                    store.server = s; store.org = o; store.deviceId = r.getString("deviceId"); store.token = r.getString("token")
                    store.userId = who.getString("id"); store.pairedAt = System.currentTimeMillis()
                    store.userName = who.getString("name"); store.organization = r.getString("organization")
                    SyncJob.schedule(this)
                    runOnUiThread { startActivity(Intent(this, MainActivity::class.java)); finish() }
                } catch (e: Exception) {
                    runOnUiThread { err.text = if (e is ApiError) e.message else "Could not reach the server. Check the address and your internet."; go.isEnabled = true; go.text = "Connect" }
                }
            }
        }
        box.addView(gap(go, 8))
        show(ScrollView(this).apply { isFillViewport = true; addView(box) })
    }
}
