import { expect, test } from '@playwright/test';

test('a comment written today displays its full date including the year', async ({ page, request }) => {
  const login = await request.post('http://localhost:4000/api/auth/login', { data: { email: 'admin@ipropy.com', password: 'Admin@123' } });
  const headers = { Authorization: `Bearer ${(await login.json()).token}` };
  const marker = `NoteYear-${Date.now()}`;
  const created = await request.post('http://localhost:4000/api/records/leads', { headers, data: { full_name: marker, mobile: `97${String(Date.now()).slice(-8)}` } });
  expect(created.ok()).toBeTruthy();
  const id = (await created.json()).id;
  try {
    const note = await request.post(`http://localhost:4000/api/records/leads/${id}/comments`, { headers, data: { body: `${marker} comment` } });
    expect(note.ok()).toBeTruthy();
    await page.goto(`/leads?open=${id}`);
    const activity = page.locator('[aria-label="Activity"]');
    await expect(activity).toContainText(`${marker} comment`);
    await expect(activity).toContainText(String(new Date().getFullYear()));
  } finally {
    await request.delete(`http://localhost:4000/api/records/leads/${id}`, { headers });
  }
});
