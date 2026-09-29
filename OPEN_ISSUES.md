# Open Issues

These are known issues to fix later. Do not treat this list as implementation instructions for the current task.

## Addressed in code, needs stage verification

1. Admin login/session persistence
   - Admin role login is unstable.
   - After refreshing the page, admin is asked to log in again.
   - Change made: Supabase auth session persistence/auto-refresh is explicitly enabled.

2. Slow initial load after login
   - Page load after login takes too long.
   - Especially noticeable for admin.
   - Change made: independent portal data now loads in parallel, and background message preload is capped.

3. Slow button actions / duplicate-click risk
   - Some actions take 6–8 seconds to complete, such as sending a message.
   - Users can click the same button again while the first request is still processing.
   - Need loading/disabled states and duplicate-submit protection across actions.
   - Change made: major forms/deletes/message sends now use action locks and disabled buttons.

4. Messages do not update automatically
   - When a client sends a message, admin/developer must refresh to see it.
   - Messages should update automatically without manual refresh.
   - Change made: active conversation polling refreshes messages when the tab is visible.

5. Client form values disappear
   - While adding a client, typed form values can disappear after clicking outside the form/page.
   - Need to preserve draft form values until submit/cancel.
   - Change made: Add Client form draft values are preserved across rerenders.
