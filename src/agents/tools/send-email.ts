import { Type } from "@sinclair/typebox";
import nodemailer from "nodemailer";
import { logWarn } from "../../logger.js";
import type { AnyAgentTool } from "./common.js";
import { jsonResult, readStringParam } from "./common.js";

const SendEmailSchema = Type.Object({
  to: Type.String({ description: "The email address of the recipient." }),
  subject: Type.String({ description: "The subject line of the email." }),
  text: Type.String({ description: "The plain text body of the email." }),
  html: Type.Optional(Type.String({ description: "Optional HTML body of the email." })),
});

export function createSendEmailTool(options?: {
  defaultUser?: string;
  defaultPass?: string;
  defaultHost?: string;
  defaultPort?: number;
}): AnyAgentTool {
  return {
    name: "send_email",
    label: "Send Email",
    description:
      "Send an email to a recipient. By default, it uses the environment variables SMTP_USER, SMTP_PASS, SMTP_HOST, and SMTP_PORT.",
    parameters: SendEmailSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const to = readStringParam(params, "to", { required: true });
      const subject = readStringParam(params, "subject", { required: true });
      const text = readStringParam(params, "text", { required: true });
      const html = params.html ? readStringParam(params, "html") : undefined;

      const user = process.env.SMTP_USER || options?.defaultUser;
      const pass = process.env.SMTP_PASS || options?.defaultPass;
      const host = process.env.SMTP_HOST || options?.defaultHost || "smtp.gmail.com";
      const port = Number(process.env.SMTP_PORT || options?.defaultPort || 465);
      const proxyUrl =
        process.env.HTTPS_PROXY ||
        process.env.https_proxy ||
        process.env.HTTP_PROXY ||
        process.env.http_proxy;

      if (!user || !pass) {
        logWarn("SMTP_USER or SMTP_PASS not defined. Email may fail.");
        return jsonResult({
          error:
            "Failed: Missing SMTP_USER or SMTP_PASS environment variables. Please provide them to the user so they can export them in their environment.",
          status: "auth_missing",
        });
      }

      const transportOptions: Record<string, unknown> = {
        host,
        port,
        secure: port === 465, // true for 465, false for other ports
        auth: {
          user,
          pass,
        },
      };

      if (proxyUrl) {
        // Nodemailer supports HTTP proxy URLs natively under 'proxy'
        transportOptions.proxy = proxyUrl;
      }

      const transporter = nodemailer.createTransport(transportOptions);

      try {
        const info = await transporter.sendMail({
          from: user,
          to,
          subject,
          text,
          html,
        });

        return jsonResult({
          success: true,
          messageId: info.messageId,
          response: info.response,
        });
      } catch (error: unknown) {
        return jsonResult({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}
