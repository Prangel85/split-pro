import { randomBytes } from 'node:crypto';
import { z } from 'zod';

import { env } from '~/env';
import { sendInviteEmail } from '~/server/mailer';

/*
 * Optional Authentik-backed friend invitations.
 *
 * When SplitPro is used behind Authentik as its only login method, the default invite flow is not
 * enough: invited people have no Authentik account (or no access to the SplitPro application).
 * When the AUTHENTIK_* variables below are set, inviting a friend by email instead:
 *
 * 1. looks the email up in Authentik;
 * 2. if the user exists but is not in AUTHENTIK_GROUP, adds them to it and emails a link to SplitPro;
 * 3. if the user exists and is already in the group, only emails the link;
 * 4. if the user does not exist, creates a single-use Authentik invitation that pre-fills the email
 *    and adds the user to AUTHENTIK_GROUP, then emails the enrollment link.
 *
 * The placeholder SplitPro user is still created by the caller, so the first OIDC login links to it
 * through the email address. If Authentik fails, an AuthentikInviteError is thrown and no other
 * invite mechanism is used as a fallback.
 *
 * The API token is only sent in the Authorization header and never logged or returned.
 */

const REQUEST_TIMEOUT_MS = 10_000;
const REQUIRED_VARS = [
  'AUTHENTIK_URL',
  'AUTHENTIK_TOKEN',
  'AUTHENTIK_GROUP',
  'AUTHENTIK_ENROLLMENT_FLOW_SLUG',
  'AUTHENTIK_APP_SLUG',
] as const;

export type AuthentikInviteOutcome = 'added_to_group' | 'already_in_group' | 'invitation_created';

/** Thrown when Authentik is unreachable, misconfigured or rejects a request. Safe to show users. */
export class AuthentikInviteError extends Error {
  constructor(message = 'Could not create the invitation in Authentik. Please try again later.') {
    super(message);
    this.name = 'AuthentikInviteError';
  }
}

export interface AuthentikConfig {
  url: string;
  token: string;
  group: string;
  flowSlug: string;
  appSlug: string;
  expiryDays: number;
}

const pkSchema = z.object({ pk: z.string() });
const groupsSchema = z.object({ results: z.array(z.object({ pk: z.string(), name: z.string() })) });
const usersSchema = z.object({
  results: z.array(
    z.object({
      pk: z.number(),
      email: z.string().nullish(),
      is_active: z.boolean(),
      groups: z.array(z.string()).optional(),
    }),
  ),
});

const getConfig = (): AuthentikConfig | null => {
  const missing = REQUIRED_VARS.filter((name) => !env[name]);
  if (REQUIRED_VARS.length === missing.length) {
    return null;
  }
  if (0 < missing.length) {
    console.error(`Authentik invites are partially configured. Missing: ${missing.join(', ')}`);
    throw new AuthentikInviteError('Authentik invitations are not configured correctly.');
  }

  return {
    url: env.AUTHENTIK_URL!,
    token: env.AUTHENTIK_TOKEN!,
    group: env.AUTHENTIK_GROUP!,
    flowSlug: env.AUTHENTIK_ENROLLMENT_FLOW_SLUG!,
    appSlug: env.AUTHENTIK_APP_SLUG!,
    expiryDays: env.AUTHENTIK_INVITE_EXPIRY_DAYS,
  };
};

interface RequestOptions {
  method?: 'GET' | 'POST';
  query?: Record<string, string>;
  body?: unknown;
}

const authentikRequest = async (config: AuthentikConfig, path: string, init: RequestOptions) => {
  const method = init.method ?? 'GET';
  const url = new URL(`/api/v3${path}`, config.url);
  Object.entries(init.query ?? {}).forEach(([key, value]) => url.searchParams.set(key, value));

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/json',
      ...(undefined !== init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: undefined !== init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  }).catch((error: unknown) => {
    // Only log the path (no query string: it may contain the invitee email) and the error name.
    console.error(
      `Authentik API ${method} ${path} failed:`,
      error instanceof Error ? error.name : 'Unknown error',
    );
    throw new AuthentikInviteError('Authentik is not reachable. Please try again later.');
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    console.error(
      `Authentik API ${method} ${path} returned ${response.status}: ${body.slice(0, 300)}`,
    );
    throw new AuthentikInviteError();
  }

  return response;
};

/** Calls an Authentik API endpoint and validates the JSON response. */
const authentikApi = async <T extends z.ZodTypeAny>(
  config: AuthentikConfig,
  path: string,
  schema: T,
  init: RequestOptions = {},
): Promise<z.infer<T>> => {
  const response = await authentikRequest(config, path, init);
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) {
    console.error(`Authentik API ${init.method ?? 'GET'} ${path} returned an unexpected response`);
    throw new AuthentikInviteError();
  }
  return parsed.data;
};

let cachedGroupPk: string | undefined = undefined;
let cachedFlowPk: string | undefined = undefined;

/** Clears cached Authentik lookups. Intended for tests. */
export const resetAuthentikInviteCache = () => {
  cachedGroupPk = undefined;
  cachedFlowPk = undefined;
};

const getGroupPk = async (config: AuthentikConfig) => {
  if (cachedGroupPk) {
    return cachedGroupPk;
  }

  const groups = await authentikApi(config, '/core/groups/', groupsSchema, {
    query: { name: config.group, include_users: 'false' },
  });
  const group = groups.results.find((g) => g.name === config.group);
  if (!group) {
    console.error(`Authentik group "${config.group}" not found or not visible to the API token`);
    throw new AuthentikInviteError('Authentik invitations are not configured correctly.');
  }

  cachedGroupPk = group.pk;
  return group.pk;
};

/**
 * Binding the invitation to the enrollment flow is optional: without the "Can view Flow"
 * permission the invitation still works, but for any flow with an Invitation stage.
 */
const getFlowPk = async (config: AuthentikConfig) => {
  if (cachedFlowPk) {
    return cachedFlowPk;
  }

  try {
    const flow = await authentikApi(
      config,
      `/flows/instances/${encodeURIComponent(config.flowSlug)}/`,
      pkSchema,
    );
    cachedFlowPk = flow.pk;
  } catch {
    console.warn('Cannot read the Authentik enrollment flow, the invitation is not bound to it');
  }
  return cachedFlowPk;
};

const findUsersByEmail = async (config: AuthentikConfig, email: string) => {
  const users = await authentikApi(config, '/core/users/', usersSchema, {
    query: { search: email, include_groups: 'true' },
  });
  const normalised = email.trim().toLowerCase();
  return users.results.filter((user) => user.email?.trim().toLowerCase() === normalised);
};

const createInvitation = async (config: AuthentikConfig, email: string) => {
  const flowPk = await getFlowPk(config);
  const invitation = await authentikApi(config, '/stages/invitation/invitations/', pkSchema, {
    method: 'POST',
    body: {
      name: `splitpro-${randomBytes(6).toString('hex')}`,
      expires: new Date(Date.now() + config.expiryDays * 24 * 3600_000).toISOString(),
      single_use: true,
      ...(flowPk ? { flow: flowPk } : {}),
      // Same as the invitation "Custom attributes": they end up in the flow's prompt data.
      fixed_data: { email, groups_to_add: [config.group] },
    },
  });
  return invitation.pk;
};

export const buildEnrollmentUrl = (config: AuthentikConfig, itoken: string) => {
  const url = new URL(`/if/flow/${encodeURIComponent(config.flowSlug)}/`, config.url);
  url.searchParams.set('itoken', itoken);
  url.searchParams.set('next', `/application/launch/${config.appSlug}/`);
  return url.toString();
};

/** Makes sure the email can sign in to SplitPro through Authentik and returns the link to email. */
export const prepareAuthentikInvite = async (
  config: AuthentikConfig,
  email: string,
): Promise<{ outcome: AuthentikInviteOutcome; signupUrl?: string }> => {
  const users = await findUsersByEmail(config, email);

  if (0 === users.length) {
    const itoken = await createInvitation(config, email);
    return { outcome: 'invitation_created', signupUrl: buildEnrollmentUrl(config, itoken) };
  }

  const activeUsers = users.filter((user) => user.is_active);
  const [firstActiveUser] = activeUsers;
  if (!firstActiveUser) {
    throw new AuthentikInviteError('The Authentik account for this email is disabled.');
  }

  const groupPk = await getGroupPk(config);
  if (activeUsers.some((user) => user.groups?.includes(groupPk))) {
    return { outcome: 'already_in_group' };
  }

  // Returns 204 No Content on success.
  await authentikRequest(config, `/core/groups/${encodeURIComponent(groupPk)}/add_user/`, {
    method: 'POST',
    body: { pk: firstActiveUser.pk },
  });
  return { outcome: 'added_to_group' };
};

/**
 * Sends a friend invitation. Without Authentik configuration this is exactly `sendInviteEmail`.
 *
 * @returns whether the email was sent (same contract as `sendInviteEmail`)
 * @throws AuthentikInviteError when Authentik is configured but fails
 */
export const sendFriendInvite = async (email: string, inviterName: string) => {
  const config = getConfig();
  if (!config) {
    return sendInviteEmail(email, inviterName);
  }

  const { signupUrl } = await prepareAuthentikInvite(config, email);
  return sendInviteEmail(email, inviterName, signupUrl);
};
