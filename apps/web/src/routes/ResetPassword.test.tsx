import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ResetPassword } from './ResetPassword';
import { authClient } from '../lib/auth';

vi.mock('../lib/auth', () => ({ authClient: { resetPassword: vi.fn() } }));

const resetPassword = authClient.resetPassword as unknown as Mock;

function renderAt(search: string) {
  window.history.replaceState(null, '', `/reset-password${search}`);
  return render(
    <MemoryRouter>
      <ResetPassword />
    </MemoryRouter>,
  );
}

function fill(password: string, confirm = password) {
  fireEvent.change(screen.getByLabelText('New password'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('The same again'), { target: { value: confirm } });
  fireEvent.click(screen.getByRole('button', { name: 'Set new password' }));
}

beforeEach(() => resetPassword.mockReset());
afterEach(cleanup);

describe('ResetPassword', () => {
  it('sets the new password with the token from the link', async () => {
    resetPassword.mockResolvedValue({ data: { status: true }, error: null });
    renderAt('?token=abc123');
    fill('a-brand-new-one');
    expect(await screen.findByRole('status')).toHaveTextContent('Your new password is set');
    expect(resetPassword).toHaveBeenCalledWith({ newPassword: 'a-brand-new-one', token: 'abc123' });
  });

  it('checks length and the second copy before sending anything', () => {
    renderAt('?token=abc123');
    fill('short');
    expect(screen.getByRole('alert')).toHaveTextContent('at least 8');
    fill('a-brand-new-one', 'something-else');
    expect(screen.getByRole('alert')).toHaveTextContent('do not match');
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it('says a used or expired link is used or expired', () => {
    renderAt('?error=INVALID_TOKEN');
    expect(screen.getByRole('alert')).toHaveTextContent('expired or was already used');
    expect(screen.queryByLabelText('New password')).not.toBeInTheDocument();
  });

  it('says so when the server refuses the token', async () => {
    resetPassword.mockResolvedValue({ data: null, error: { code: 'INVALID_TOKEN', message: 'x' } });
    renderAt('?token=stale');
    fill('a-brand-new-one');
    expect(await screen.findByRole('alert')).toHaveTextContent('expired or was already used');
  });
});
