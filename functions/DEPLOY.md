# Deploying GridX Admin Cloud Functions

These Cloud Functions send shortlist/rejection emails when an admin updates an applicant's status.

## Prerequisites

1. **Firebase CLI** — Install globally:
   ```bash
   npm install -g firebase-tools
   ```

2. **Blaze plan** — Upgrade your Firebase project (`websitegridx`) to the Blaze (pay-as-you-go) plan at [console.firebase.google.com](https://console.firebase.google.com). Cloud Functions require this plan. You only pay for actual usage.

3. **Gmail App Password** (or other SMTP provider):
   - Enable 2-Step Verification on the Gmail account you want to send from.
   - Go to [https://myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) and generate an App Password.

## Setup

```bash
# Login to Firebase
firebase login

# Initialize (select Functions when prompted, choose JavaScript, say No to ESLint)
firebase init functions

# Install dependencies
cd functions
npm install
cd ..
```

## Set SMTP Secrets

```bash
firebase functions:secrets:set SMTP_EMAIL
# Enter: your-email@gmail.com

firebase functions:secrets:set SMTP_PASSWORD
# Enter: the app password you generated
```

## Deploy

```bash
firebase deploy --only functions
```

## How It Works

- When an admin clicks Shortlist or Reject in `movio.html`, the Firestore document at `applications/{appId}` is updated with:
  - `status`: `"shortlisted"` or `"rejected"`
  - `emailSubject`: The subject line (editable by admin)
  - `emailBody`: The full email text (editable by admin)
- The `sendStatusEmail` Cloud Function triggers on any update to `applications/{appId}`.
- It checks if `status` changed to `shortlisted` or `rejected`.
- If so, it sends the email to the applicant using the admin-edited `emailBody`.
