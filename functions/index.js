const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { initializeApp } = require("firebase-admin/app");
const nodemailer = require("nodemailer");

initializeApp();

/*
 * Configure your SMTP credentials via environment variables.
 *
 * For Gmail:
 *   1. Enable 2-Step Verification on your Google account
 *   2. Create an App Password at https://myaccount.google.com/apppasswords
 *   3. Set these in your Firebase project:
 *      firebase functions:secrets:set SMTP_EMAIL
 *      firebase functions:secrets:set SMTP_PASSWORD
 *
 * Or use any other SMTP provider (e.g. SendGrid, Mailgun) by changing
 * the transporter config below.
 */

const sendStatusEmail = onDocumentUpdated(
  {
    document: "applications/{appId}",
    secrets: ["SMTP_EMAIL", "SMTP_PASSWORD"],
  },
  async (event) => {
    const before = event.data.before.data();
    const after = event.data.after.data();

    if (before.status === after.status) return;
    if (after.status !== "shortlisted" && after.status !== "rejected") return;
    if (!after.emailBody || !after.email) return;

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const mailOptions = {
      from: `GridXenergy Careers <${process.env.SMTP_EMAIL}>`,
      to: after.email,
      subject: after.emailSubject || "Your Application at GridXenergy — Update",
      text: after.emailBody,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Email sent to ${after.email} (${after.status})`);
    } catch (err) {
      console.error("Failed to send email:", err);
    }
  }
);

module.exports = { sendStatusEmail };
