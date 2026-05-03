import React, { useState } from 'react';
import { Lock, User, LogIn, Zap, KeyRound, ShieldCheck } from 'lucide-react';
import { api } from '../lib/api';
import type { UserRole } from '../types';

type Props = { onLogin: (role: UserRole) => void };

function normalizeRole(role: unknown): UserRole {
  return role === 'admin' || role === 'user' || role === 'readonly' ? role : 'user';
}

export default function LoginPage({ onLogin }: Props) {
  const [view, setView] = useState<'login' | 'change-password'>('login');

  // login form state
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [loginLoading, setLoginLoading] = useState(false);

  // change-password form state
  const [pendingToken, setPendingToken] = useState('');
  const [pendingRole, setPendingRole]   = useState<UserRole>('user');
  const [currentPw,  setCurrentPw]      = useState('');
  const [newPw,      setNewPw]          = useState('');
  const [confirmPw,  setConfirmPw]      = useState('');
  const [cpError,    setCpError]        = useState('');
  const [cpLoading,  setCpLoading]      = useState(false);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoginLoading(true);
    setLoginError('');
    try {
      const res = await api.post('/auth/login', { username, password });
      if (res.success && res.token) {
        if (res.user.must_change_password) {
          // Store token temporarily so change-password can call the endpoint.
          setPendingToken(res.token);
          setPendingRole(normalizeRole(res.user.role));
          setCurrentPw(password); // pre-fill current password
          setView('change-password');
        } else {
          const role = normalizeRole(res.user.role);
          localStorage.setItem('token', res.token);
          localStorage.setItem('userRole', role);
          onLogin(role);
        }
      } else {
        setLoginError(res.error?.message || 'Giriş başarısız.');
      }
    } catch (err: any) {
      setLoginError(err.message || 'Giriş sırasında bir hata oluştu.');
    } finally {
      setLoginLoading(false);
    }
  };

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setCpError('');
    if (newPw !== confirmPw) {
      setCpError('Yeni şifreler eşleşmiyor.');
      return;
    }
    if (newPw.length < 8) {
      setCpError('Şifre en az 8 karakter olmalıdır.');
      return;
    }
    setCpLoading(true);
    try {
      const res = await fetch('/api/auth/change-password', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${pendingToken}`,
        },
        body: JSON.stringify({ current_password: currentPw, new_password: newPw }),
      });
      const data = await res.json();
      if (data.success) {
        // Re-login with new password to get a fresh token.
        const loginRes = await api.post('/auth/login', { username, password: newPw });
        if (loginRes.success && loginRes.token) {
          localStorage.setItem('token', loginRes.token);
          localStorage.setItem('userRole', pendingRole);
          onLogin(pendingRole);
        }
      } else {
        setCpError(data.error?.message || 'Şifre değiştirilemedi.');
      }
    } catch (err: any) {
      setCpError(err.message || 'Bir hata oluştu.');
    } finally {
      setCpLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#FDFDFD] flex flex-col items-center justify-center p-6 font-sans relative overflow-hidden">
      <div className="absolute top-[-10%] right-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-3xl animate-pulse" />
      <div className="absolute bottom-[-10%] left-[-10%] w-[40%] h-[40%] bg-primary/5 rounded-full blur-3xl animate-pulse" />

      <div className="w-full max-w-md relative z-10">
        <div className="flex items-center justify-center space-x-3 mb-12">
          <div className="w-12 h-12 bg-primary rounded-2xl flex items-center justify-center shadow-lg shadow-blue-200">
            <Zap className="text-white w-6 h-6 fill-white" />
          </div>
          <span className="text-2xl font-black tracking-tight text-text-main uppercase">DSDST Panel</span>
        </div>

        <div className="w-full bg-white rounded-[30px] lg:rounded-[40px] shadow-2xl shadow-blue-900/5 p-8 lg:p-12 border border-border-color">
          {view === 'login' ? (
            <>
              <div className="text-center mb-8">
                <h2 className="text-2xl lg:text-3xl font-black text-text-main tracking-tight">Hoş Geldiniz</h2>
                <p className="text-sm text-text-muted mt-2 font-medium">Devam etmek için giriş yapın.</p>
              </div>

              <form onSubmit={handleLogin} className="space-y-6">
                <div className="space-y-2">
                  <label className="text-[11px] font-black text-text-muted uppercase tracking-widest px-1">Kullanıcı Adı</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted"><User className="w-5 h-5" /></div>
                    <input required type="text" value={username} onChange={(e) => setUsername(e.target.value)}
                      placeholder="Kullanıcı adınızı girin"
                      className="w-full h-14 pl-12 pr-4 bg-bg-main border border-border-color rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium" />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] font-black text-text-muted uppercase tracking-widest px-1">Şifre</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted"><Lock className="w-5 h-5" /></div>
                    <input required type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                      placeholder="Şifrenizi girin"
                      className="w-full h-14 pl-12 pr-4 bg-bg-main border border-border-color rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium" />
                  </div>
                </div>

                {loginError && (
                  <div className="bg-red-50 text-red-600 text-xs font-bold p-4 rounded-xl flex items-center">
                    <Lock className="w-4 h-4 mr-2 shrink-0" />{loginError}
                  </div>
                )}

                <button disabled={loginLoading}
                  className="w-full h-14 bg-primary text-white rounded-2xl font-black text-lg shadow-xl shadow-blue-200 hover:scale-[1.02] transition-all flex items-center justify-center group">
                  {loginLoading
                    ? <div className="w-6 h-6 border-b-2 border-white rounded-full animate-spin" />
                    : <><span>Giriş Yap</span><LogIn className="w-5 h-5 ml-2 group-hover:translate-x-1 transition-transform" /></>}
                </button>
              </form>
            </>
          ) : (
            <>
              <div className="text-center mb-8">
                <div className="w-14 h-14 bg-amber-50 rounded-2xl flex items-center justify-center mx-auto mb-4">
                  <ShieldCheck className="w-7 h-7 text-amber-500" />
                </div>
                <h2 className="text-2xl font-black text-text-main tracking-tight">Şifrenizi Değiştirin</h2>
                <p className="text-sm text-text-muted mt-2 font-medium">
                  İlk girişte güvenlik için yeni bir şifre belirlemeniz zorunludur.
                </p>
              </div>

              <form onSubmit={handleChangePassword} className="space-y-5">
                <div className="space-y-2">
                  <label className="text-[11px] font-black text-text-muted uppercase tracking-widest px-1">Mevcut Şifre</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted"><Lock className="w-5 h-5" /></div>
                    <input required type="password" value={currentPw} onChange={(e) => setCurrentPw(e.target.value)}
                      placeholder="Mevcut şifreniz"
                      className="w-full h-14 pl-12 pr-4 bg-bg-main border border-border-color rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium" />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] font-black text-text-muted uppercase tracking-widest px-1">Yeni Şifre</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted"><KeyRound className="w-5 h-5" /></div>
                    <input required type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)}
                      placeholder="En az 8 karakter"
                      className="w-full h-14 pl-12 pr-4 bg-bg-main border border-border-color rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium" />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-[11px] font-black text-text-muted uppercase tracking-widest px-1">Yeni Şifre (Tekrar)</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted"><KeyRound className="w-5 h-5" /></div>
                    <input required type="password" value={confirmPw} onChange={(e) => setConfirmPw(e.target.value)}
                      placeholder="Şifreyi tekrar girin"
                      className="w-full h-14 pl-12 pr-4 bg-bg-main border border-border-color rounded-2xl focus:ring-4 focus:ring-primary/10 focus:border-primary outline-none transition-all font-medium" />
                  </div>
                </div>

                {cpError && (
                  <div className="bg-red-50 text-red-600 text-xs font-bold p-4 rounded-xl flex items-center">
                    <Lock className="w-4 h-4 mr-2 shrink-0" />{cpError}
                  </div>
                )}

                <button disabled={cpLoading}
                  className="w-full h-14 bg-primary text-white rounded-2xl font-black text-lg shadow-xl shadow-blue-200 hover:scale-[1.02] transition-all flex items-center justify-center group">
                  {cpLoading
                    ? <div className="w-6 h-6 border-b-2 border-white rounded-full animate-spin" />
                    : <><span>Şifremi Güncelle</span><ShieldCheck className="w-5 h-5 ml-2" /></>}
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      <div className="mt-20 text-[10px] font-black text-text-muted uppercase tracking-[0.3em] opacity-40">
        © 2026 DSDST Global Operations Center
      </div>
    </div>
  );
}
