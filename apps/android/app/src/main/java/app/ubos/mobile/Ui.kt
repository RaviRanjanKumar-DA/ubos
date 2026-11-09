package app.ubos.mobile

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.text.InputType
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView

/** Small helpers so screens share one look, matching the web app. */
object Ui {
    val brand = Color.parseColor("#4A2BC2")
    val ink = Color.parseColor("#1B1830")
    val muted = Color.parseColor("#6D6985")
    val line = Color.parseColor("#E4E1EE")
    val bg = Color.parseColor("#F5F4FA")
    val soft = Color.parseColor("#F2EFFD")
    val bad = Color.parseColor("#BB3226")
    val okBg = Color.parseColor("#E0F5E8")
    val ok = Color.parseColor("#17854A")

    fun Context.dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    fun Context.round(fill: Int, radius: Int = 12, stroke: Int? = null) = GradientDrawable().apply {
        setColor(fill); cornerRadius = dp(radius).toFloat(); if (stroke != null) setStroke(dp(1), stroke)
    }

    fun Context.label(s: String, size: Float = 15f, color: Int = ink, bold: Boolean = false) = TextView(this).apply {
        text = s; setTextSize(TypedValue.COMPLEX_UNIT_SP, size); setTextColor(color); if (bold) typeface = Typeface.DEFAULT_BOLD
    }

    fun Context.primary(s: String, click: () -> Unit) = Button(this).apply {
        text = s; isAllCaps = false; setTextColor(Color.WHITE); background = round(brand, 10); stateListAnimator = null; minHeight = dp(48); setOnClickListener { click() }
    }

    fun Context.outline(s: String, click: () -> Unit) = Button(this).apply {
        text = s; isAllCaps = false; setTextColor(brand); background = round(Color.WHITE, 10, Color.parseColor("#CFC6F2")); stateListAnimator = null; minHeight = dp(44); setOnClickListener { click() }
    }

    fun Context.input(hint: String, type: Int = InputType.TYPE_CLASS_TEXT) = EditText(this).apply {
        this.hint = hint; contentDescription = hint; inputType = type; setTextColor(ink); setHintTextColor(muted); background = round(Color.WHITE, 10, Color.parseColor("#D6D2E4")); setPadding(dp(12), dp(10), dp(12), dp(10)); minHeight = dp(48)
    }

    fun lp(w: Int = ViewGroup.LayoutParams.MATCH_PARENT, h: Int = ViewGroup.LayoutParams.WRAP_CONTENT) = LinearLayout.LayoutParams(w, h)
    fun Context.gap(view: View, top: Int): View { view.layoutParams = (view.layoutParams as? LinearLayout.LayoutParams ?: lp()).apply { topMargin = dp(top) }; return view }

    fun Context.column(pad: Int = 16) = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(dp(pad), dp(pad), dp(pad), dp(pad)) }
    fun Context.row() = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }

    /** Android draws apps under the status and navigation bars; this keeps content clear of them and of the keyboard. */
    fun Activity.show(root: View) {
        // Android 11 and later report the bars and keyboard this way; older versions use the theme's bar colour and resize for the keyboard.
        if (Build.VERSION.SDK_INT >= 30) {
            root.setOnApplyWindowInsetsListener { v, i: WindowInsets ->
                val bars = i.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.ime())
                v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
                i
            }
            window.decorView.post { window.insetsController?.setSystemBarsAppearance(WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS, WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS) }
        } else {
            root.fitsSystemWindows = true
        }
        root.setBackgroundColor(bg)
        setContentView(root)
    }
}
