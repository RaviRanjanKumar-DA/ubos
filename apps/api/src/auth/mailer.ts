import { Injectable, Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

/** Sends mail via SMTP. Locally this is Mailpit (http://localhost:8025) — nothing leaves the laptop. */
@Injectable()
export class Mailer {
  private readonly log = new Logger('Mailer');
  private readonly transport = nodemailer.createTransport({
    host: process.env.SMTP_HOST ?? 'localhost',
    port: Number(process.env.SMTP_PORT ?? 1025),
    secure: process.env.SMTP_SECURE === 'true',
    auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
  });

  async send(to: string, subject: string, text: string, attachments?: { filename: string; content: string; contentType?: string }[]) {
    try {
      await this.transport.sendMail({ from: process.env.MAIL_FROM ?? 'UBOS <no-reply@ubos.local>', to, subject, text, ...(attachments?.length ? { attachments } : {}) });
    } catch (e) {
      this.log.error(`Mail to ${to} failed: ${e instanceof Error ? e.message : e}`);
      throw e;
    }
  }
}
