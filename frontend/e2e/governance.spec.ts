import { createHmac } from 'node:crypto';
import { expect, test } from '@playwright/test';

const API_URL = process.env.PLAYWRIGHT_API_URL ?? 'http://localhost:4000';
const SESSION_SECRET = process.env.AUTH_SESSION_SECRET ?? 'governance-e2e-secret';
const MEMBER_ADDRESS = 'GDMZRAGTOJHQK3LN3D2EDLEAMS76EDIQEMWCUTYIYHUE5HFPLPGBCGUS';

function createSessionToken(address: string): string {
  const now = Math.floor(Date.now() / 1_000);
  const body = Buffer.from(JSON.stringify({ address, iat: now, exp: now + 3_600 })).toString(
    'base64url'
  );
  const signature = createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
}

test('a member creates a proposal and casts a vote through the real stack', async ({
  page,
  request,
}) => {
  const token = createSessionToken(MEMBER_ADDRESS);
  const communityResponse = await request.post(`${API_URL}/api/v1/communities`, {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: `Governance E2E ${Date.now()}`,
      description: 'Community created by the Playwright governance flow',
      issuerPublicKey: MEMBER_ADDRESS,
      assetCode: 'GOV',
      assetIssuer: MEMBER_ADDRESS,
    },
  });

  expect(communityResponse.ok()).toBeTruthy();
  const communityEnvelope = (await communityResponse.json()) as { data: { id: string } };

  // The browser still talks to the real backend. This wrapper only supplies the
  // same signed session header a connected wallet would establish.
  await page.addInitScript((sessionToken) => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('Authorization', `Bearer ${sessionToken}`);
      return nativeFetch(input, { ...init, headers });
    };
  }, token);

  await page.goto(`/governance?communityId=${communityEnvelope.data.id}`);
  await page.getByLabel('Title').fill('Fund the community clinic');
  await page
    .getByLabel('Description')
    .fill('Release the approved grant for essential medical supplies.');
  await page.getByRole('button', { name: 'Create proposal' }).click();

  await expect(page.getByRole('heading', { name: 'Fund the community clinic' })).toBeVisible();
  await expect(page.getByText('Proposal created and voting is open.')).toBeVisible();
  await expect(page.getByTestId('votes-for')).toHaveText('0');

  await page.getByRole('button', { name: 'Vote for' }).click();

  await expect(page.getByText('Vote recorded.')).toBeVisible();
  await expect(page.getByTestId('votes-for')).toHaveText('1.0000000');
});
