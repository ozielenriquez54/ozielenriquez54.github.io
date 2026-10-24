# Recovery reload correction — local verification

Scope: local callback/controller changes only. No deployment, remote Auth calls,
link generation, user changes, migrations or business-write activation.

Result: PASS — 42 distinct related local tests passed; no failures.
`git diff --check` passed. Ready for deployment to the isolated preproduction
service only, subject to the compatibility limitation below.

The successful invite/recovery exchange now records only the expected Auth user ID
in tab sessionStorage. A clean callback reload uses `auth.getUser()` to validate the
current session against that ID before showing the password form; it does not
consume the OTP again. The same validation runs immediately before `auth.updateUser`.
Password setup does not query profiles/memberships or invoke business RPCs. Success
shows a dedicated password-updated status and clears the recovery reference.
Normal application access continues to require its existing authorization checks.

Missing/different sessions, malformed callbacks and explicit expired/used links
remain rejected. No token or password is added to application logs or recovery
storage; the existing SDK session handling is unchanged.

Compatibility limitation: the old marker `1` contains no expected user identity and
is deliberately rejected. Deploying this correction cannot by itself resume a
previously consumed link with only that old marker. Do not manually promote an
arbitrary current session into recovery. Successful exchange under the corrected
flow is required to establish the identity reference. Reload before that exchange
has completed is not covered by session resumption.

Local verification commands (from `pilot-backend`):

```powershell
node --test tests/password-links.test.cjs tests/recovery-resume.test.cjs tests/pilot-auth.test.cjs tests/complex-auth-ui.test.cjs
node --test --test-name-pattern='Render serves|invite parsing|invite verifies|read-only auth|invitation UI' tests/render-readonly.test.cjs
node --test --test-name-pattern='invited client sets own password' tests/preproduction-fixes.test.cjs
```

Tests use synthetic Auth responses and a local HTTP server. They cover invite and
recovery reload, absent/wrong sessions, session change before submission, expired
and used links, malformed callbacks, missing/legacy markers, logout during
validation, sanitized errors, password retry, membership independence and closed
business writes. These are local regression checks, not a real client/browser or
Supabase acceptance test. Preproduction acceptance remains pending deployment.
