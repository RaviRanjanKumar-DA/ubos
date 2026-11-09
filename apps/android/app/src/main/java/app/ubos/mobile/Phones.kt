package app.ubos.mobile

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/** Pure helpers, kept free of Android classes so they can be unit tested. */
object Phones {
    /** Numbers are compared on their last 10 digits, so +91 and 0 prefixes do not matter. */
    fun key(number: String?): String = (number ?: "").filter { it.isDigit() }.takeLast(10)

    fun externalId(deviceId: String, callLogId: Long, startedAt: Long) = "$deviceId:$callLogId:$startedAt"
}

/** UBOS shows every date in IST, whatever the phone is set to. */
object Ist {
    val zone: TimeZone = TimeZone.getTimeZone("Asia/Kolkata")
    private fun fmt(p: String) = SimpleDateFormat(p, Locale("en", "IN")).apply { timeZone = zone }
    fun dateTime(ms: Long): String = fmt("d MMM, h:mm a").format(Date(ms))
    fun time(ms: Long): String = fmt("h:mm a").format(Date(ms))
    fun day(ms: Long): String = fmt("yyyy-MM-dd").format(Date(ms))
    fun iso(ms: Long): String = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.format(Date(ms))
    fun parse(iso: String?): Long? {
        if (iso.isNullOrBlank()) return null
        return try { SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }.parse(iso)?.time } catch (_: Exception) { null }
    }
    /** The moment a given IST date and time happens. */
    fun at(year: Int, month: Int, day: Int, hour: Int, minute: Int): Long =
        java.util.Calendar.getInstance(zone).apply { clear(); set(year, month, day, hour, minute, 0) }.timeInMillis
    fun endOfToday(now: Long): Long = java.util.Calendar.getInstance(zone).apply { timeInMillis = now; set(java.util.Calendar.HOUR_OF_DAY, 23); set(java.util.Calendar.MINUTE, 59); set(java.util.Calendar.SECOND, 59) }.timeInMillis
    fun daysAhead(now: Long, days: Int, hour: Int): Long = java.util.Calendar.getInstance(zone).apply { timeInMillis = now; add(java.util.Calendar.DAY_OF_YEAR, days); set(java.util.Calendar.HOUR_OF_DAY, hour); set(java.util.Calendar.MINUTE, 0); set(java.util.Calendar.SECOND, 0); set(java.util.Calendar.MILLISECOND, 0) }.timeInMillis
}
