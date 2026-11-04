# Google Calendar setup for Nox

Nox talks to Google Calendar with **your own** OAuth client, so nothing goes through a
third-party server. You do this once (about 10 minutes). The Google Cloud console changes
its menus now and then, so a label may read slightly differently from what is written here.

What Nox asks for: `calendar.readonly` (read your calendars) and `calendar.events` (create
the events you confirm). Nox never edits or deletes events.

## 1. Create a project

1. Open <https://console.cloud.google.com/> and sign in with the Google account whose calendar
   you use.
2. Use the project picker at the top → **New project**, name it `Nox`, then create and select it.

## 2. Enable the Google Calendar API

1. Go to **APIs & Services → Library**.
2. Search for **Google Calendar API**, open it, and click **Enable**.

## 3. Configure the consent screen (Google Auth Platform)

Go to **APIs & Services → OAuth consent screen** (the newer console calls this section **Google
Auth Platform**, with the pages Branding, Audience, Clients, Data access).

1. **Branding**: app name `Nox`, user support email = your address, developer contact = your
   address. Save.
2. **Audience**: user type **External** (Internal is for users of one Google Workspace
   organization).
   While the app is in **Testing**, add your own address under **Test users**.
3. **Data access** (optional): add the scopes
   `https://www.googleapis.com/auth/calendar.readonly` and
   `https://www.googleapis.com/auth/calendar.events`. Nox asks for exactly these when you
   connect, either way.

Read section 6 before deciding whether to leave the app in Testing.

## 4. Create the OAuth client (Desktop app)

1. Go to **Clients** (or **Credentials → Create credentials → OAuth client ID**).
2. Application type: **Desktop app**. Name: `Nox`. Create.
3. Copy the **Client ID** (it ends with `.apps.googleusercontent.com`) and the **Client
   secret**.

Nox receives Google's answer on a loopback address (`http://127.0.0.1:<random free port>`).
Google's guide for installed apps recommends this for Windows desktop apps
(<https://developers.google.com/identity/protocols/oauth2/native-app>, "Loopback IP
address"). If Google ever rejects the redirect when you connect, that page is the place to
check.

## 5. Connect Nox

1. In Nox: **Integrations → Google Calendar**. Paste the Client ID and Client secret and click
   **Save client**. They go to Windows Credential Manager and are never shown again.
2. Click **Connect**. Your browser opens Google's sign-in.
   - Pick your account.
   - If Google shows an "unverified app" warning, it is about your own app; continue past it
     (section 6 explains why it appears).
   - Allow **both** calendar permissions.
3. The browser says "Nox is connected". Back in Nox, your main calendar is on and syncs at once.
   Turn on other calendars in the list if you want them.

**Disconnect** revokes Nox's access with Google and deletes the token from Credential Manager.
**Remove client** also deletes the client id/secret. You can also remove Nox at
<https://myaccount.google.com/permissions>.

## 6. Do refresh tokens expire while the app is in "Testing"?

**Yes.** Checked against Google's documentation on 2026-11-04:

- Google's OAuth 2.0 overview, under refresh token expiration, says a Google Cloud project with
  an external user type and the publishing status "Testing" "is issued a refresh token expiring
  in 7 days", unless the only scopes requested are a subset of name, email address and user
  profile. Calendar scopes are not in that subset.
  Source: <https://developers.google.com/identity/protocols/oauth2> (section "Refresh token
  expiration").
- Google Cloud Help, "Manage App Audience": in Testing, "Authorizations by a test user will
  expire seven days from the time of consent", and a refresh token obtained then "will also
  expire". Testing is also limited to 100 test users.
  Source: <https://support.google.com/cloud/answer/15549945>.

In practice: in Testing, Nox stops syncing about a week after you connect. The Integrations
page then shows "Google Calendar needs to be connected again", and Connect fixes it for
another 7 days.

### Avoiding it for a personal app

Google's documented way out of the 7-day limit is to stop being in Testing: set the
publishing status to **In production** with **Publish app** on the Audience page (same
source as above: "A project's publishing status is considered In production after selecting
the Publish app button"). What Google's pages say about that state:

- When an app asks for scopes that need verification and has not been verified, Google shows
  an **unverified app** warning on the consent screen, and the app is limited to **100 new
  users** in total. For an app only you use, that limit does not matter. Sources:
  <https://support.google.com/cloud/answer/15549945>,
  <https://support.google.com/cloud/answer/7454865> ("Unverified apps").
- The "Unverified apps" page lists apps that do not need verification: apps in development
  (unless you launch them to the public), some OAuth plugins, and internal apps of one Google
  Workspace organization. **It does not mention a personal-use exemption.** Nox does not
  claim one. Keeping your app private and used only by you is the honest situation to
  describe if Google ever asks.

Not verified here, so not claimed: whether Google labels `calendar.readonly` /
`calendar.events` as "sensitive" in the console. The Calendar API scope page
(<https://developers.google.com/workspace/calendar/api/auth>) lists the scopes and what they
allow, without a sensitivity column. The console shows the label when you add the scopes in
step 3.

So the choice is yours:

- **Stay in Testing**: no warning screen, but reconnect about once a week.
- **Publish (In production), unverified**: a warning screen once when you connect, then no
  7-day expiry. The other reasons below still apply.

### Other reasons a refresh token stops working

From the same OAuth 2.0 overview page (source above):

- You revoke access (Disconnect in Nox, or at myaccount.google.com/permissions).
- The token has not been used for six months. Nox uses it every 30 minutes while it runs.
- Your account exceeds the number of live refresh tokens: "a limit of 100 refresh tokens per
  Google Account per OAuth 2.0 client ID". Each Connect creates one; the oldest stop working
  past the limit.
- You granted time-based access and it ran out.
- (Gmail scopes only, not Nox's: a password change.)

### About the client secret

For desktop apps Google says: "Desktop apps are public clients and cannot keep secrets
confidential" (<https://developers.google.com/identity/protocols/oauth2/native-app>). The
secret alone does not give access to your calendar; your consent and the refresh token do.
Nox still keeps both in Windows Credential Manager and never shows, logs or sends them
anywhere but Google's token endpoint. Nox also uses PKCE (S256), which that page says to
always use.
