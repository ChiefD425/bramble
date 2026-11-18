package app.bramble.mobile

import java.security.SecureRandom

// The password a "New login" made in the autofill picker starts with. The provider runs outside
// the app and can't reach its generator, so this mirrors that generator's defaults: 20 characters
// from every class, one of each guaranteed (sites that demand a digit or a symbol accept it).
object PasswordGenerator {
    const val LOWERCASE = "abcdefghijklmnopqrstuvwxyz"
    const val UPPERCASE = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    const val DIGITS = "0123456789"
    const val SYMBOLS = "!@#\$%^&*()_+-=[]{}|;:,.<>?"
    private const val LENGTH = 20
    private val random = SecureRandom()

    fun generate(): String {
        val classes = listOf(LOWERCASE, UPPERCASE, DIGITS, SYMBOLS)
        val pool = classes.joinToString("")
        val out = classes.map { it[random.nextInt(it.length)] }.toMutableList()
        while (out.size < LENGTH) out.add(pool[random.nextInt(pool.length)])
        for (i in out.size - 1 downTo 1) {
            val j = random.nextInt(i + 1)
            out[i] = out[j].also { out[j] = out[i] }
        }
        return out.joinToString("")
    }
}
