import React, { useState } from 'react';
import { Lock, KeyRound, Mail, AlertTriangle, ShieldCheck, RefreshCw, Eye, EyeOff } from 'lucide-react';

interface OperatorLoginProps {
  onLoginSuccess: (user: { id: string; email: string; name?: string }, token: string) => void;
}

export const OperatorLogin: React.FC<OperatorLoginProps> = ({ onLoginSuccess }) => {
  const [identity, setIdentity] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!identity.trim() || !password) {
      setError('Please enter your username/email and password.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/auth/operator/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity: identity.trim(), password }),
      });

      const data = await res.json();
      if (!res.ok || !data.success) {
        setError(data.error || 'Invalid username or password.');
      } else {
        localStorage.setItem('printhive_operator_token', data.token);
        localStorage.setItem('printhive_operator_user', JSON.stringify(data.user));
        onLoginSuccess(data.user, data.token);
      }
    } catch (err: any) {
      setError('Network error connecting to PocketBase auth service.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="max-w-md mx-auto py-12 px-4 sm:px-6">
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 sm:p-8 backdrop-blur-md shadow-2xl space-y-6">
        
        {/* Header Icon */}
        <div className="text-center space-y-2">
          <div className="w-14 h-14 rounded-2xl bg-amber-500/10 border border-amber-500/20 text-[#CEB888] flex items-center justify-center mx-auto shadow-lg shadow-amber-500/5">
            <ShieldCheck className="w-7 h-7" />
          </div>
          <h2 className="text-2xl font-extrabold text-white tracking-tight">Operator Desk Login</h2>
          <p className="text-xs text-slate-400 max-w-xs mx-auto">
            Staff access is restricted. Sign in with your PocketBase <strong className="text-slate-300">users</strong> account.
          </p>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="bg-red-500/10 border border-red-500/20 text-red-300 text-xs p-3 rounded-xl flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
            <span>{error}</span>
          </div>
        )}

        {/* Login Form */}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Username or Email
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                <Mail className="w-4 h-4" />
              </div>
              <input
                type="text"
                autoComplete="username"
                value={identity}
                onChange={(e) => setIdentity(e.target.value)}
                placeholder="staff@purdue.edu or username"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-[#CEB888]"
                required
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-300 mb-1">
              Password
            </label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                <Lock className="w-4 h-4" />
              </div>
              <input
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-10 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none focus:border-[#CEB888]"
                required
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-slate-500 hover:text-slate-300"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-3 bg-[#CEB888] hover:bg-[#d6c499] text-slate-950 font-bold text-sm rounded-xl transition-all shadow-lg shadow-amber-500/10 flex items-center justify-center gap-2"
          >
            {loading ? (
              <>
                <RefreshCw className="w-4 h-4 animate-spin" />
                Authenticating...
              </>
            ) : (
              'Sign In to Operator Desk'
            )}
          </button>
        </form>

        {/* Footer info */}
        <div className="border-t border-slate-800/80 pt-4 text-center">
          <p className="text-[11px] text-slate-500 font-mono">
            Accounts are managed in PocketBase under the <span className="text-amber-300 font-semibold">users</span> collection.
          </p>
        </div>

      </div>
    </div>
  );
};
