import { type Transporter, createTransport } from 'nodemailer';

import { env } from '~/env';
import { escapeHtml } from '~/lib/utils';

import { sendToDiscord } from './service-notification';

// oxlint-disable-next-line init-declarations
let transporter: Transporter;

export const mailServerConfig = {
  host: env.EMAIL_SERVER_HOST,
  port: parseInt(env.EMAIL_SERVER_PORT ?? ''),
  auth: { user: env.EMAIL_SERVER_USER, pass: env.EMAIL_SERVER_PASSWORD },
  tls: {
    rejectUnauthorized: env.NODE_ENV !== 'development' ? env.EMAIL_TLS_REJECT_UNAUTHORIZED : false,
  },
};

const getTransporter = () => {
  if (transporter) {
    return transporter;
  }

  if (!mailServerConfig.host) {
    return undefined;
  }

  const transport = {
    ...mailServerConfig,
    secure: 465 === mailServerConfig.port,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
  };

  transporter = createTransport(transport);
  return transporter;
};

export async function sendSignUpEmail(email: string, url: string, token: string) {
  const { host } = new URL(url);

  console.log(env.NODE_ENV);

  if ('development' === env.NODE_ENV) {
    console.log('Sign in link : ', email, url, token);
    return true;
  }

  const subject = 'Sign in to SplitPro';
  const text = `Hey,\n\nYou can sign in to SplitPro by clicking the below URL:\n${url}\n\nYou can also use this OTP: ${token}\n\nThanks,\nSplitPro Team`;
  const html = `<p>Hey,</p> <p>You can sign in to SplitPro by clicking the below URL:</p><p><a href="${url}">Sign in to ${host}</a></p><p>You can also use this OTP: <b>${token}</b></p><br /><br /><p>Thanks,</p><br/>SplitPro Team</p>`;

  return await sendMail(email, subject, text, html);
}

/**
 * Sends the "you have been invited" email.
 *
 * By default the email links to the SplitPro instance. When `signupUrl` is provided (e.g. an
 * identity-provider registration link created by `~/server/authentikInvites`), the email asks the
 * recipient to create their account through that link instead.
 */
export async function sendInviteEmail(email: string, name: string, signupUrl?: string) {
  if (!env.ENABLE_SENDING_INVITES) {
    throw new Error('Sending invites is not enabled');
  }

  const url = signupUrl ?? env.NEXTAUTH_URL;
  const { host } = new URL(env.NEXTAUTH_URL);

  if ('development' === env.NODE_ENV) {
    console.log('Sending invite email', email, name, url);
    return true;
  }

  const action = signupUrl
    ? 'You can create your account by clicking the below URL'
    : 'You can sign in to SplitPro by clicking the below URL';
  const linkLabel = signupUrl ? `Create your account for ${host}` : `Sign in to ${host}`;

  const subject = 'Invitation to SplitPro';
  const text = `Hey,\n\nYou have been invited to SplitPro by ${name}. It's a completely open source free alternative to splitwise. ${action}:\n${url}\n\nThanks,\nSplitPro Team`;
  const html = `<p>Hey,</p> <p>You have been invited to SplitPro by ${escapeHtml(name)}. It's a completely open source free alternative to splitwise. ${action}:</p><p><a href="${escapeHtml(url)}">${escapeHtml(linkLabel)}</a></p><br><p>Thanks,<br/>SplitPro Team</p>`;

  return await sendMail(email, subject, text, html);
}

export async function sendFeedbackEmail(
  feedback: string,
  user: { name?: string | null; email?: string | null },
) {
  console.log('Received feedback from: ', user.email, 'Feedback: ', feedback);

  if (!env.FEEDBACK_EMAIL) {
    return;
  }

  const subject = `Feedback received on SplitPro from ${user.name}`;
  const text = `Feedback created by ${user.name} :\n\nFeedback: ${feedback}\n\nemail: ${user.email}`;

  await sendMail(env.FEEDBACK_EMAIL, subject, text, text, user.email ?? undefined);
}

async function sendMail(
  email: string,
  subject: string,
  text: string,
  html: string,
  replyTo?: string,
) {
  const mailTransporter = getTransporter();
  try {
    if (mailTransporter) {
      await mailTransporter.sendMail({
        to: email,
        from: env.FROM_EMAIL,
        subject,
        text,
        html,
        replyTo,
      });

      console.log('Email sent');
      return true;
    } else {
      console.log('SMTP server not configured, so skipping');
    }
  } catch (error) {
    console.log('Error sending email', error);
    await Promise.resolve(
      sendToDiscord(
        `Error sending email: ${
          error instanceof Error
            ? `error.message: ${error.message}\nerror.stack: ${error.stack}`
            : 'Unknown error'
        }`,
      ),
    ).catch((notificationError: unknown) => {
      console.error('Failed to report email error to Discord', notificationError);
    });
  }

  return false;
}
