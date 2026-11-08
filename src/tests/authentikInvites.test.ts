import { env } from '~/env';
import {
  AuthentikInviteError,
  resetAuthentikInviteCache,
  sendFriendInvite,
} from '~/server/authentikInvites';
import { sendInviteEmail } from '~/server/mailer';

const TOKEN = 'super-secret-authentik-token';
const GROUP_PK = 'group-uuid-splitpro';

jest.mock('~/env', () => ({
  env: {
    AUTHENTIK_URL: 'https://auth.example.com',
    AUTHENTIK_TOKEN: 'super-secret-authentik-token',
    AUTHENTIK_GROUP: 'SplitPro',
    AUTHENTIK_ENROLLMENT_FLOW_SLUG: 'invite-enrollment',
    AUTHENTIK_APP_SLUG: 'splitpro',
    AUTHENTIK_INVITE_EXPIRY_DAYS: 7,
  },
}));

jest.mock('~/server/mailer', () => ({
  sendInviteEmail: jest.fn(),
}));

const mockSendInviteEmail = jest.mocked(sendInviteEmail);
const mutableEnv = env as unknown as Record<string, string | number | undefined>;
const originalEnv = { ...mutableEnv };

type Route = (url: URL, init: RequestInit) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const fetchMock = jest.fn<Promise<Response>, [URL, RequestInit]>();

/** Routes Authentik API calls by "METHOD /path/" and records every request. */
const mockAuthentik = (routes: Record<string, Route>) => {
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(input);
    const key = `${init.method ?? 'GET'} ${url.pathname}`;
    const route = routes[key];
    if (!route) {
      throw new Error(`Unexpected Authentik call: ${key}`);
    }
    return route(url, init);
  });
};

const calls = () =>
  fetchMock.mock.calls.map(([input, init]) => ({
    key: `${init.method ?? 'GET'} ${new URL(input).pathname}`,
    url: new URL(input),
    init,
    body: 'string' === typeof init.body ? (JSON.parse(init.body) as unknown) : undefined,
  }));

const groupsRoute: Route = () => json({ results: [{ pk: GROUP_PK, name: 'SplitPro' }] });

describe('sendFriendInvite', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    Object.assign(mutableEnv, originalEnv);
    resetAuthentikInviteCache();
    global.fetch = fetchMock as unknown as typeof fetch;
    mockSendInviteEmail.mockResolvedValue(true);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('when the user exists in Authentik but is not in the SplitPro group', () => {
    it('adds the user to the group and emails the SplitPro link', async () => {
      mockAuthentik({
        'GET /api/v3/core/users/': () =>
          json({
            results: [{ pk: 42, email: 'Friend@Example.com', is_active: true, groups: ['other'] }],
          }),
        'GET /api/v3/core/groups/': groupsRoute,
        [`POST /api/v3/core/groups/${GROUP_PK}/add_user/`]: () =>
          new Response(null, { status: 204 }),
      });

      await expect(sendFriendInvite('friend@example.com', 'Alice')).resolves.toBe(true);

      const addUser = calls().find((call) => call.key.endsWith('/add_user/'));
      expect(addUser?.body).toEqual({ pk: 42 });
      expect(calls().some((call) => call.key.includes('/invitations/'))).toBe(false);
      expect(mockSendInviteEmail).toHaveBeenCalledWith('friend@example.com', 'Alice', undefined);
    });

    it('sends the token only in the Authorization header', async () => {
      mockAuthentik({
        'GET /api/v3/core/users/': () =>
          json({ results: [{ pk: 42, email: 'friend@example.com', is_active: true, groups: [] }] }),
        'GET /api/v3/core/groups/': groupsRoute,
        [`POST /api/v3/core/groups/${GROUP_PK}/add_user/`]: () =>
          new Response(null, { status: 204 }),
      });

      await sendFriendInvite('friend@example.com', 'Alice');

      calls().forEach((call) => {
        expect((call.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
        expect(call.url.toString()).not.toContain(TOKEN);
      });
    });
  });

  describe('when the user exists in Authentik and is already in the SplitPro group', () => {
    it('only emails the SplitPro link', async () => {
      mockAuthentik({
        'GET /api/v3/core/users/': () =>
          json({
            results: [{ pk: 7, email: 'friend@example.com', is_active: true, groups: [GROUP_PK] }],
          }),
        'GET /api/v3/core/groups/': groupsRoute,
      });

      await expect(sendFriendInvite('friend@example.com', 'Alice')).resolves.toBe(true);

      expect(calls().map((call) => call.key)).toEqual([
        'GET /api/v3/core/users/',
        'GET /api/v3/core/groups/',
      ]);
      expect(mockSendInviteEmail).toHaveBeenCalledWith('friend@example.com', 'Alice', undefined);
    });
  });

  describe('when the user does not exist in Authentik', () => {
    it('creates a single-use invitation with the group and email and emails the enrollment link', async () => {
      const now = Date.parse('2026-11-08T10:00:00.000Z');
      jest.spyOn(Date, 'now').mockReturnValue(now);
      mockAuthentik({
        // A search can return similar addresses: only an exact email match counts.
        'GET /api/v3/core/users/': () =>
          json({ results: [{ pk: 3, email: 'otherfriend@example.com', is_active: true }] }),
        'GET /api/v3/flows/instances/invite-enrollment/': () => json({ pk: 'flow-uuid' }),
        'POST /api/v3/stages/invitation/invitations/': () => json({ pk: 'invite-token' }, 201),
      });

      await expect(sendFriendInvite('friend@example.com', 'Alice')).resolves.toBe(true);

      const invitation = calls().find((call) => call.key.endsWith('/invitations/'));
      expect(invitation?.body).toEqual({
        name: expect.stringMatching(/^splitpro-[0-9a-f]{12}$/) as unknown,
        expires: '2026-11-15T10:00:00.000Z',
        single_use: true,
        flow: 'flow-uuid',
        fixed_data: { email: 'friend@example.com', groups_to_add: ['SplitPro'] },
      });
      expect(calls().some((call) => call.key.endsWith('/add_user/'))).toBe(false);

      const signupUrl = new URL(mockSendInviteEmail.mock.calls[0]?.[2] ?? '');
      expect(signupUrl.origin + signupUrl.pathname).toBe(
        'https://auth.example.com/if/flow/invite-enrollment/',
      );
      expect(signupUrl.searchParams.get('itoken')).toBe('invite-token');
      expect(signupUrl.searchParams.get('next')).toBe('/application/launch/splitpro/');
    });

    it('still creates the invitation when the flow cannot be read', async () => {
      mockAuthentik({
        'GET /api/v3/core/users/': () => json({ results: [] }),
        'GET /api/v3/flows/instances/invite-enrollment/': () => json({ detail: 'denied' }, 403),
        'POST /api/v3/stages/invitation/invitations/': () => json({ pk: 'invite-token' }, 201),
      });

      await expect(sendFriendInvite('friend@example.com', 'Alice')).resolves.toBe(true);

      const invitation = calls().find((call) => call.key.endsWith('/invitations/'));
      expect(invitation?.body).not.toHaveProperty('flow');
    });
  });

  describe('when Authentik fails', () => {
    it('throws an AuthentikInviteError and sends no email on HTTP errors', async () => {
      mockAuthentik({
        'GET /api/v3/core/users/': () => json({ detail: 'You do not have permission' }, 403),
      });

      await expect(sendFriendInvite('friend@example.com', 'Alice')).rejects.toBeInstanceOf(
        AuthentikInviteError,
      );
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
    });

    it('throws an AuthentikInviteError when Authentik is unreachable', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      await expect(sendFriendInvite('friend@example.com', 'Alice')).rejects.toThrow(
        'Authentik is not reachable',
      );
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
    });

    it('never puts the token in errors or logs', async () => {
      mockAuthentik({
        'GET /api/v3/core/users/': () => json({ detail: 'boom' }, 500),
      });

      const error = await sendFriendInvite('friend@example.com', 'Alice').catch(
        (err: unknown) => err,
      );

      expect(String(error)).not.toContain(TOKEN);
      jest.mocked(console.error).mock.calls.forEach((args) => {
        expect(JSON.stringify(args)).not.toContain(TOKEN);
      });
    });

    it('throws when the configuration is incomplete instead of falling back', async () => {
      mutableEnv.AUTHENTIK_APP_SLUG = undefined;

      await expect(sendFriendInvite('friend@example.com', 'Alice')).rejects.toBeInstanceOf(
        AuthentikInviteError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSendInviteEmail).not.toHaveBeenCalled();
    });
  });

  describe('when Authentik invites are not configured', () => {
    it('sends the default invite email without calling Authentik', async () => {
      [
        'AUTHENTIK_URL',
        'AUTHENTIK_TOKEN',
        'AUTHENTIK_GROUP',
        'AUTHENTIK_ENROLLMENT_FLOW_SLUG',
        'AUTHENTIK_APP_SLUG',
      ].forEach((name) => {
        mutableEnv[name] = undefined;
      });

      await expect(sendFriendInvite('friend@example.com', 'Alice')).resolves.toBe(true);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(mockSendInviteEmail).toHaveBeenCalledWith('friend@example.com', 'Alice');
    });
  });
});
