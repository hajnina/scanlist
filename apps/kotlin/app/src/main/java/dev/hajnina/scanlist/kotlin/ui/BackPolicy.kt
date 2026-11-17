package dev.hajnina.scanlist.kotlin.ui

import dev.hajnina.scanlist.kotlin.Tab

// Card B7 — back behaviour, decided in one pure function.
//
// The shell (B1/B2) navigates with plain state: a tab enum plus an optional open list id. Android's
// system back used to fall straight through to the Activity, so pressing back on the List screen
// closed the app instead of returning to Lists (a real polish bug, and the reason this file exists).
//
// The rule (identical to every list app the guide's sources imitate):
//   open list → close the list (stay on the tab),
//   non-Lists tab → go to Lists,
//   Lists tab with nothing open → let the system leave the app.

/** What system back should do from the current shell state. */
enum class BackTarget {
    /** A list detail screen is open: pop it, stay where we are. */
    CLOSE_LIST,

    /** No list open, but not on the Lists tab: return to Lists. */
    LISTS_TAB,

    /** Nothing left to pop: the Activity handles back (exit). */
    EXIT,
}

/** Should the app consume the back press itself? */
val BackTarget.handledLocally: Boolean get() = this != BackTarget.EXIT

fun backTarget(tab: Tab, openListId: String?): BackTarget = when {
    openListId != null -> BackTarget.CLOSE_LIST
    tab != Tab.Lists -> BackTarget.LISTS_TAB
    else -> BackTarget.EXIT
}
