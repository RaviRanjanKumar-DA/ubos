package app.ubos.mobile

import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL

class ApiError(val status: Int, val code: String, message: String) : Exception(message)

object Api {
    private fun read(c: HttpURLConnection): JSONObject {
        val status = c.responseCode
        val stream = if (status < 400) c.inputStream else c.errorStream
        val out = ByteArrayOutputStream()
        stream?.use { it.copyTo(out) }
        val text = out.toString("UTF-8")
        val json = try { if (text.isBlank()) JSONObject() else JSONObject(text) } catch (_: Exception) { JSONObject() }
        if (status >= 400) throw ApiError(status, json.optString("code", "HTTP_$status"), json.optString("message", "The server answered $status"))
        return json
    }

    private fun open(url: String, method: String, token: String?): HttpURLConnection =
        (URL(url).openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = 15_000
            readTimeout = 30_000
            if (token != null) setRequestProperty("Authorization", "Device $token")
        }

    fun json(server: String, path: String, method: String, token: String?, body: JSONObject? = null): JSONObject {
        val c = open(server.trimEnd('/') + path, method, token)
        try {
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json")
                c.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            return read(c)
        } finally { c.disconnect() }
    }

    fun putChunk(server: String, path: String, token: String, bytes: ByteArray, count: Int, start: Long, total: Long, mime: String): JSONObject {
        val c = open(server.trimEnd('/') + path, "PUT", token)
        try {
            c.doOutput = true
            c.setFixedLengthStreamingMode(count)
            c.setRequestProperty("Content-Type", mime)
            c.setRequestProperty("Content-Range", "bytes $start-${start + count - 1}/$total")
            c.outputStream.use { it.write(bytes, 0, count) }
            return read(c)
        } finally { c.disconnect() }
    }
}
