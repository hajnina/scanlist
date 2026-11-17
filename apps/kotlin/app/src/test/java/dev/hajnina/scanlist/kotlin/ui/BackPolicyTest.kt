package dev.hajnina.scanlist.kotlin.ui

import dev.hajnina.scanlist.kotlin.Tab
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Card B7 — the back-stack rule of the shell, one test per row of the truth table. */
class BackPolicyTest {

    @Test
    fun `back on an open list closes it`() {
        assertEquals(BackTarget.CLOSE_LIST, backTarget(Tab.Lists, "list-1"))
        // The list is pushed on top of whatever tab was showing; the tab must not change.
        assertEquals(BackTarget.CLOSE_LIST, backTarget(Tab.Scan, "list-1"))
        assertEquals(BackTarget.CLOSE_LIST, backTarget(Tab.Settings, "list-1"))
    }

    @Test
    fun `back on a non-lists tab returns to lists`() {
        assertEquals(BackTarget.LISTS_TAB, backTarget(Tab.Scan, null))
        assertEquals(BackTarget.LISTS_TAB, backTarget(Tab.Settings, null))
    }

    @Test
    fun `back on the lists root exits`() {
        assertEquals(BackTarget.EXIT, backTarget(Tab.Lists, null))
    }

    @Test
    fun `only exit is left to the system`() {
        assertTrue(BackTarget.CLOSE_LIST.handledLocally)
        assertTrue(BackTarget.LISTS_TAB.handledLocally)
        assertFalse(BackTarget.EXIT.handledLocally)
    }
}
