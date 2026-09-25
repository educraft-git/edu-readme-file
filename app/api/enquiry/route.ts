import { createHmac, timingSafeEqual } from "node:crypto";
import { Resend } from "resend";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_BODY_SIZE = 10_000;

type Enquiry = {
  name: string;
  email: string;
  phone: string;
  message: string;
};

function isValidFramerSignature(
  secret: string,
  submissionId: string,
  payload: Buffer,
  signature: string,
) {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) {
    return false;
  }

  const expectedSignature = `sha256=${createHmac("sha256", secret)
    .update(payload)
    .update(submissionId)
    .digest("hex")}`;

  return timingSafeEqual(
    Buffer.from(signature),
    Buffer.from(expectedSignature),
  );
}

function parseEnquiry(value: unknown): Enquiry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const body = value as Record<string, unknown>;
  if (
    (body.phone != null && typeof body.phone !== "string") ||
    (body.message != null && typeof body.message !== "string")
  ) {
    return null;
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";
  const phone = body.phone?.trim() ?? "";
  const message = body.message?.trim() ?? "";

  if (
    !name ||
    name.length > 100 ||
    !EMAIL_PATTERN.test(email) ||
    email.length > 254 ||
    phone.length > 50 ||
    message.length > 5_000
  ) {
    return null;
  }

  return {
    name,
    email,
    phone: phone || "Not provided",
    message: message || "No message provided",
  };
}

export async function POST(request: Request) {
  const signature = request.headers.get("framer-signature");
  const submissionId = request.headers.get("framer-webhook-submission-id");
  const webhookSecret = process.env.FRAMER_WEBHOOK_SECRET;

  if (!signature || !submissionId || !webhookSecret) {
    return Response.json(
      { success: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  if (!request.headers.get("content-type")?.includes("application/json")) {
    return Response.json(
      { success: false, error: "Content-Type must be application/json." },
      { status: 415 },
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_SIZE) {
    return Response.json(
      { success: false, error: "Request body is too large." },
      { status: 413 },
    );
  }

  let rawBody: Buffer;

  try {
    rawBody = Buffer.from(await request.arrayBuffer());
  } catch {
    return Response.json(
      { success: false, error: "Unable to read request body." },
      { status: 400 },
    );
  }

  if (rawBody.byteLength > MAX_BODY_SIZE) {
    return Response.json(
      { success: false, error: "Request body is too large." },
      { status: 413 },
    );
  }

  if (
    !isValidFramerSignature(
      webhookSecret,
      submissionId,
      rawBody,
      signature,
    )
  ) {
    return Response.json(
      { success: false, error: "Unauthorized." },
      { status: 401 },
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return Response.json(
      { success: false, error: "Invalid JSON body." },
      { status: 400 },
    );
  }

  const enquiry = parseEnquiry(body);

  if (!enquiry) {
    return Response.json(
      { success: false, error: "Valid name and email are required." },
      { status: 400 },
    );
  }

  const apiKey = process.env.RESEND_API_KEY;
  const templateId = process.env.RESEND_TEMPLATE_ID;
  const recipient = process.env.ENQUIRY_RECIPIENT;

  if (!apiKey || !templateId || !recipient) {
    console.error("Enquiry email environment variables are not configured.");
    return Response.json(
      { success: false, error: "Email service is not configured." },
      { status: 500 },
    );
  }

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      to: recipient,
      replyTo: enquiry.email,
      template: {
        id: templateId,
        variables: {
          NAME: enquiry.name,
          VISITOR_EMAIL: enquiry.email,
          PHONE: enquiry.phone,
          MESSAGE: enquiry.message,
        },
      },
    });

    if (error) {
      console.error("Resend rejected an enquiry email:", error.name);
      return Response.json(
        { success: false, error: "Unable to send enquiry." },
        { status: 502 },
      );
    }

    return Response.json({ success: true, id: data?.id });
  } catch (error) {
    console.error(
      "Failed to send enquiry email:",
      error instanceof Error ? error.message : "Unknown error",
    );
    return Response.json(
      { success: false, error: "Unable to send enquiry." },
      { status: 500 },
    );
  }
}
