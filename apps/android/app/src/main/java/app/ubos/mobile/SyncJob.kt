package app.ubos.mobile

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.telephony.TelephonyManager
import kotlin.concurrent.thread

/** Runs in the background: every 15 minutes, and as soon as possible after a call ends. Waits for a network by itself. */
class SyncJob : JobService() {
    override fun onStartJob(params: JobParameters): Boolean {
        thread {
            var again = false
            try {
                val sync = Sync(this)
                val dial = sync.all()
                Queue(this).nextOutcome()?.let { sync.notifyOutcome(it) }
                if (dial.length() > 0) {
                    val d = dial.getJSONObject(0)
                    val lead = Store(this).loadSync()?.optJSONArray("leads")?.let { a -> (0 until a.length()).map { a.getJSONObject(it) }.firstOrNull { it.optString("id") == d.optString("leadId") } }
                    sync.notifyDial(d.getString("number"), lead?.optString("name") ?: "a customer")
                }
            } catch (e: ApiError) { again = e.status >= 500 } catch (_: Exception) { again = true }
            jobFinished(params, again)
        }
        return true
    }
    override fun onStopJob(params: JobParameters) = true

    companion object {
        private const val PERIODIC = 1
        private const val NOW = 2
        private fun cn(c: Context) = ComponentName(c, SyncJob::class.java)
        fun schedule(c: Context) {
            c.getSystemService(JobScheduler::class.java).schedule(JobInfo.Builder(PERIODIC, cn(c)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setPeriodic(15 * 60_000L).setPersisted(true).build())
        }
        fun soon(c: Context) {
            c.getSystemService(JobScheduler::class.java).schedule(JobInfo.Builder(NOW, cn(c)).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY).setMinimumLatency(2_000).setBackoffCriteria(30_000, JobInfo.BACKOFF_POLICY_EXPONENTIAL).build())
        }
    }
}

/** When a call ends, the call log gets its entry a moment later, so the job reads it shortly after. */
class CallReceiver : BroadcastReceiver() {
    override fun onReceive(c: Context, i: Intent) {
        if (Store(c).token == null) return
        when (i.action) {
            Intent.ACTION_BOOT_COMPLETED -> SyncJob.schedule(c)
            TelephonyManager.ACTION_PHONE_STATE_CHANGED -> if (i.getStringExtra(TelephonyManager.EXTRA_STATE) == TelephonyManager.EXTRA_STATE_IDLE) SyncJob.soon(c)
        }
    }
}
