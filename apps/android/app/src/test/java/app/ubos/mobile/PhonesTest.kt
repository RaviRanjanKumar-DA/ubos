package app.ubos.mobile

import org.junit.Assert.assertEquals
import org.junit.Test

class PhonesTest {
    @Test fun prefixesDoNotMatter() {
        assertEquals("9876543210", Phones.key("+91 98765-43210"))
        assertEquals("9876543210", Phones.key("09876543210"))
        assertEquals("", Phones.key(null))
    }
    @Test fun keyIsStable() = assertEquals("d1:42:1700000000000", Phones.externalId("d1", 42, 1_700_000_000_000))
    @Test fun followUpsAreInIst() {
        val at = Ist.at(2026, 10, 10, 11, 0) // 10 Nov 2026, 11:00 IST
        assertEquals("2026-11-10T05:30:00.000Z", Ist.iso(at))
        assertEquals("2026-11-10", Ist.day(at))
    }
    @Test fun readsServerDates() = assertEquals(1_700_000_000_000L, Ist.parse("2023-11-14T22:13:20.000Z"))
    @Test fun badDateIsNull() = assertEquals(null, Ist.parse("not a date"))
}
