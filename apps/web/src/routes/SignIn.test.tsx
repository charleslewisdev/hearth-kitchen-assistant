import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { INVITE_ONLY_MESSAGE, SETUP_TOKEN_HEADER } from '@hearth/server/src/messages';
import { RESET_PASSWORD_PATH, SignIn, VERIFIED_CALLBACK, verificationOutcome } from './SignIn';
import { authClient } from '../lib/auth';

vi.mock('../lib/auth', () => ({
  authClient: {
    signIn: { email: vi.fn() },
    signUp: { email: vi.fn() },
    requestPasswordReset: vi.fn(),
  },
}));

const signInEmail = authClient.signIn.email as unknown as Mock;
const signUpEmail = authClient.signUp.email as unknown as Mock;

beforeEach(() => {
  signInEmail.mockReset();
  signUpEmail.mockReset();
  signInEmail.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
});

afterEach(cleanup);

describe('SignIn', () => {
  it('says the instance is invite-only, and offers no way to register', () => {
    render(<SignIn />);

    expect(screen.getByText(INVITE_ONLY_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create an account' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Create account' })).not.toBeInTheDocument();
  });

  it('keeps the first-boot form closed, behind a summary that says who it is for', () => {
    render(<SignIn />);

    const summary = screen.getByText('Setting up this Hearth for the first time?');
    // Closed by default: what a stranger sees is a sign-in form and a sentence, and the form
    // inside is inert without a token only whoever runs the server can read.
    expect(summary.closest('details')).not.toHaveAttribute('open');
  });

  it('signs in with the typed credentials', async () => {
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-good-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(signInEmail).toHaveBeenCalledTimes(1);
    expect(signInEmail).toHaveBeenCalledWith({
      email: 'ada@example.com',
      password: 'a-good-password',
      callbackURL: VERIFIED_CALLBACK,
    });
  });

  it('says a new link was sent when the address is not verified yet', async () => {
    signInEmail.mockResolvedValue({
      data: null,
      error: { code: 'EMAIL_NOT_VERIFIED', message: 'Email not verified' },
    });
    render(<SignIn />);
    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'a-good-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Hearth just sent a new link');
  });

  it('surfaces a refused sign-in', async () => {
    signInEmail.mockResolvedValue({ data: null, error: { message: 'Invalid email or password' } });
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Email address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');
  });

  it('sends the setup token as a header, not as part of the account', async () => {
    signUpEmail.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: 'the-token' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Your email address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'a-good-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    expect(signUpEmail).toHaveBeenCalledTimes(1);
    expect(signUpEmail).toHaveBeenCalledWith(
      {
        email: 'ada@example.com',
        password: 'a-good-password',
        name: 'Ada',
        callbackURL: VERIFIED_CALLBACK,
      },
      { headers: { [SETUP_TOKEN_HEADER]: 'the-token' } },
    );
  });

  it('says where the verification link went, since sign-up cannot sign you in', async () => {
    signUpEmail.mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: 'the-token' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Your email address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'a-good-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    expect(await screen.findByRole('status')).toHaveTextContent(/server log/i);
  });

  it('will not claim the instance without a token', () => {
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Ada' } });
    fireEvent.change(screen.getByLabelText('Your email address'), {
      target: { value: 'ada@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'a-good-password' },
    });

    expect(screen.getByRole('button', { name: 'Create the first account' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Create the first account' }));
    expect(signUpEmail).not.toHaveBeenCalled();
  });

  it('surfaces a refused claim, which is what a claimed instance answers', async () => {
    signUpEmail.mockResolvedValue({ data: null, error: { message: INVITE_ONLY_MESSAGE } });
    render(<SignIn />);

    fireEvent.change(screen.getByLabelText('Setup token'), { target: { value: 'stale-token' } });
    fireEvent.change(screen.getByLabelText('Your name'), { target: { value: 'Squatter' } });
    fireEvent.change(screen.getByLabelText('Your email address'), {
      target: { value: 'squatter@example.com' },
    });
    fireEvent.change(screen.getByLabelText('Choose a password'), {
      target: { value: 'a-good-password' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create the first account' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(INVITE_ONLY_MESSAGE);
  });
});

describe('verificationOutcome', () => {
  it('reads what a followed verification link came back with', () => {
    expect(verificationOutcome('?verified=1')).toBe('verified');
    expect(verificationOutcome('?verified=1&error=TOKEN_EXPIRED')).toBe('expired');
    expect(verificationOutcome('?verified=1&error=INVALID_TOKEN')).toBe('invalid');
    expect(verificationOutcome('')).toBeNull();
  });
});

describe('forgot password', () => {
  it('asks for a reset link back to the reset page, and says the same thing either way', async () => {
    const requestReset = authClient.requestPasswordReset as unknown as Mock;
    requestReset.mockResolvedValue({ data: { status: true }, error: null });
    render(<SignIn />);
    fireEvent.click(screen.getByText('Forgot your password?'));
    fireEvent.change(screen.getByLabelText('Email for the account'), {
      target: { value: ' ada@example.com ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send a reset link' }));
    expect(await screen.findByRole('status')).toHaveTextContent('If that address has an account');
    expect(requestReset).toHaveBeenCalledWith({
      email: 'ada@example.com',
      redirectTo: RESET_PASSWORD_PATH,
    });
  });
});
