const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const { google } = require("googleapis");
const nodemailer = require("nodemailer");

initializeApp();
const db = getFirestore();

// ===== Send shortlist/rejection emails on status change =====

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

// ===== Shortlist with Google Meet scheduling =====

const shortlistWithMeet = onCall(
  {
    secrets: [
      "CALENDAR_CREDENTIALS_JSON",
      "CALENDAR_OWNER_EMAIL",
    ],
  },
  async (request) => {
    if (!request.auth || !request.auth.token.email?.endsWith("@gridxenergy.in")) {
      throw new HttpsError("permission-denied", "Only @gridxenergy.in accounts can perform this action.");
    }

    const {
      appId,
      meetingDateTime,
      duration = 60,
      additionalEmails = [],
      emailSubject,
      emailBody,
      updatedBy,
    } = request.data;

    if (!appId || !meetingDateTime || !emailSubject || !emailBody) {
      throw new HttpsError("invalid-argument", "Missing required fields: appId, meetingDateTime, emailSubject, emailBody.");
    }

    // Fetch the application
    const appDoc = await db.collection("applications").doc(appId).get();
    if (!appDoc.exists) {
      throw new HttpsError("not-found", "Application not found.");
    }

    const appData = appDoc.data();
    const applicantName = `${appData.firstName || ""} ${appData.lastName || ""}`.trim();
    const applicantEmail = appData.email;
    const jobTitle = appData.jobTitle || "Interview";

    if (!applicantEmail) {
      throw new HttpsError("failed-precondition", "Applicant has no email address.");
    }

    // Parse credentials and build Google Calendar client
    let credentials;
    try {
      credentials = JSON.parse(process.env.CALENDAR_CREDENTIALS_JSON);
    } catch (e) {
      console.error("Failed to parse CALENDAR_CREDENTIALS_JSON:", e);
      throw new HttpsError("internal", "Calendar credentials misconfigured.");
    }

    const calendarOwner = process.env.CALENDAR_OWNER_EMAIL;
    if (!calendarOwner) {
      throw new HttpsError("internal", "CALENDAR_OWNER_EMAIL is not set.");
    }

    const auth = new google.auth.JWT({
      email: credentials.client_email,
      key: credentials.private_key,
      scopes: ["https://www.googleapis.com/auth/calendar"],
      subject: calendarOwner,
    });

    const calendar = google.calendar({ version: "v3", auth });

    // Build event — treat meetingDateTime as IST if no timezone offset present
    const timeZone = "Asia/Kolkata";
    const dtString = (meetingDateTime.includes("+") || meetingDateTime.includes("Z"))
      ? meetingDateTime
      : meetingDateTime + "+05:30";
    const startTime = new Date(dtString);
    const endTime = new Date(startTime.getTime() + duration * 60 * 1000);

    const attendees = [{ email: applicantEmail }];
    if (Array.isArray(additionalEmails)) {
      additionalEmails.forEach((e) => {
        const trimmed = e.trim();
        if (trimmed && trimmed.includes("@")) {
          attendees.push({ email: trimmed });
        }
      });
    }

    const requestId = `gridx-${appId}-${Date.now()}`;

    let meetLink = "";
    try {
      const event = await calendar.events.insert({
        calendarId: "primary",
        conferenceDataVersion: 1,
        sendUpdates: "all",
        resource: {
          summary: `${applicantName} : ${jobTitle}`,
          description: `Interview for ${jobTitle} position at GridXenergy.\n\nApplicant: ${applicantName} (${applicantEmail})`,
          start: { dateTime: startTime.toISOString(), timeZone },
          end: { dateTime: endTime.toISOString(), timeZone },
          attendees,
          conferenceData: {
            createRequest: {
              requestId,
              conferenceSolutionKey: { type: "hangoutsMeet" },
            },
          },
          reminders: {
            useDefault: false,
            overrides: [
              { method: "email", minutes: 30 },
              { method: "popup", minutes: 10 },
            ],
          },
        },
      });

      const entryPoints = event.data.conferenceData?.entryPoints;
      if (entryPoints && entryPoints.length > 0) {
        meetLink = entryPoints.find((ep) => ep.entryPointType === "video")?.uri || entryPoints[0].uri;
      }
    } catch (err) {
      console.error("Google Calendar API error:", err.message);
      throw new HttpsError("internal", "Failed to create Google Meet event. Check Calendar API setup.");
    }

    // Append meet link to email body
    let finalEmailBody = emailBody;
    if (meetLink) {
      finalEmailBody += `\n\n--- Interview Details ---\nJoin your interview via Google Meet: ${meetLink}\nDate & Time: ${startTime.toLocaleString("en-IN", { timeZone, dateStyle: "full", timeStyle: "short" })}\nDuration: ${duration} minutes`;
    }

    // Update Firestore
    await db.collection("applications").doc(appId).update({
      status: "shortlisted",
      emailSubject,
      emailBody: finalEmailBody,
      statusUpdatedAt: FieldValue.serverTimestamp(),
      statusUpdatedBy: updatedBy || request.auth.token.email,
      meetLink: meetLink || null,
      meetingDateTime: startTime.toISOString(),
      meetingDuration: duration,
      additionalEmails: additionalEmails.filter((e) => e.trim()),
    });

    return { success: true, meetLink };
  }
);

// ===== Send email only (no status change) =====

const sendEmailOnly = onCall(
  {
    secrets: ["SMTP_EMAIL", "SMTP_PASSWORD"],
  },
  async (request) => {
    if (!request.auth || !request.auth.token.email?.endsWith("@gridxenergy.in")) {
      throw new HttpsError("permission-denied", "Only @gridxenergy.in accounts can perform this action.");
    }

    const { appId, emailSubject, emailBody } = request.data;

    if (!appId || !emailSubject || !emailBody) {
      throw new HttpsError("invalid-argument", "Missing required fields: appId, emailSubject, emailBody.");
    }

    const appDoc = await db.collection("applications").doc(appId).get();
    if (!appDoc.exists) {
      throw new HttpsError("not-found", "Application not found.");
    }

    const appData = appDoc.data();
    const toEmail = appData.email;

    if (!toEmail) {
      throw new HttpsError("failed-precondition", "Applicant has no email address.");
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.SMTP_EMAIL,
        pass: process.env.SMTP_PASSWORD,
      },
    });

    const mailOptions = {
      from: `GridXenergy Careers <${process.env.SMTP_EMAIL}>`,
      to: toEmail,
      subject: emailSubject,
      text: emailBody,
    };

    try {
      await transporter.sendMail(mailOptions);
      console.log(`Email sent to ${toEmail} (sendEmailOnly)`);
      return { success: true };
    } catch (err) {
      console.error("Failed to send email:", err);
      throw new HttpsError("internal", "Failed to send email.");
    }
  }
);

module.exports = { sendStatusEmail, shortlistWithMeet, sendEmailOnly };
