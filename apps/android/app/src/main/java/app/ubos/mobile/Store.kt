package app.ubos.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.io.File
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Pairing details. The device token is encrypted with a key held in the Android Keystore. */
class Store(private val ctx: Context) {
    private val p = ctx.getSharedPreferences("ubos", Context.MODE_PRIVATE)
    private val alias = "ubos_device_token"

    var server: String get() = p.getString("server", "") ?: ""; set(v) = p.edit().putString("server", v).apply()
    var org: String get() = p.getString("org", "") ?: ""; set(v) = p.edit().putString("org", v).apply()
    var deviceId: String get() = p.getString("deviceId", "") ?: ""; set(v) = p.edit().putString("deviceId", v).apply()
    var userName: String get() = p.getString("userName", "") ?: ""; set(v) = p.edit().putString("userName", v).apply()
    var organization: String get() = p.getString("organization", "") ?: ""; set(v) = p.edit().putString("organization", v).apply()
    var userId: String get() = p.getString("userId", "") ?: ""; set(v) = p.edit().putString("userId", v).apply()
    var pairedAt: Long get() = p.getLong("pairedAt", 0); set(v) = p.edit().putLong("pairedAt", v).apply()
    /** Stays the same when the phone is paired again, so a call always keeps the same key and can never be counted twice. */
    val installId: String get() = p.getString("installId", null) ?: java.util.UUID.randomUUID().toString().also { p.edit().putString("installId", it).apply() }
    var lastSync: Long get() = p.getLong("lastSync", 0); set(v) = p.edit().putLong("lastSync", v).apply()
    /** The call just placed from the app, so it can be tied to the right lead. */
    var dialLead: String get() = p.getString("dialLead", "") ?: ""; set(v) = p.edit().putString("dialLead", v).apply()
    var dialNumber: String get() = p.getString("dialNumber", "") ?: ""; set(v) = p.edit().putString("dialNumber", v).apply()

    private fun key(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (ks.getKey(alias, null) as? SecretKey)?.let { return it }
        val g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        g.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        return g.generateKey()
    }

    var token: String?
        get() {
            val blob = p.getString("token", null) ?: return null
            return try {
                val raw = Base64.decode(blob, Base64.NO_WRAP)
                val c = Cipher.getInstance("AES/GCM/NoPadding")
                c.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, raw, 0, 12))
                String(c.doFinal(raw, 12, raw.size - 12))
            } catch (_: Exception) { null }
        }
        set(v) {
            if (v == null) { p.edit().remove("token").apply(); return }
            val c = Cipher.getInstance("AES/GCM/NoPadding")
            c.init(Cipher.ENCRYPT_MODE, key())
            p.edit().putString("token", Base64.encodeToString(c.iv + c.doFinal(v.toByteArray()), Base64.NO_WRAP)).apply()
        }

    private val cache get() = File(ctx.filesDir, "sync.json")
    fun saveSync(j: JSONObject) { cache.writeText(j.toString()) }
    fun loadSync(): JSONObject? = try { if (cache.exists()) JSONObject(cache.readText()) else null } catch (_: Exception) { null }

    fun unpair() { token = null; deviceId = ""; lastSync = 0; dialLead = ""; dialNumber = ""; cache.delete() }
}
