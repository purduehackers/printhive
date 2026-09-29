import React, { useState, useMemo } from 'react';
import { UploadCloud, CheckCircle2, AlertTriangle, ArrowRight, ShieldCheck, Mail, KeyRound, RefreshCw, FileCode } from 'lucide-react';
import { STLViewer } from './STLViewer';
import { DEFAULT_SETTINGS, type PrintSettings } from '../types';

interface SubmissionFormProps {
  onJobSubmitted: () => void;
}

export const SubmissionForm: React.FC<SubmissionFormProps> = ({ onJobSubmitted }) => {
  // Step state
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');

  // Print settings
  const [infill, setInfill] = useState<number>(DEFAULT_SETTINGS.infill);
  const [layerHeight, setLayerHeight] = useState<number>(DEFAULT_SETTINGS.layerHeight);
  const [material, setMaterial] = useState<string>(DEFAULT_SETTINGS.material);
  const [supports, setSupports] = useState<string>(DEFAULT_SETTINGS.supports);

  // Email verification state
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [isVerified, setIsVerified] = useState(false);
  const [emailError, setEmailError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<string | null>(null);
  const [devCodeTip, setDevCodeTip] = useState<string | null>(null);

  // Loading states
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submittedJob, setSubmittedJob] = useState<any | null>(null);

  // Determine non-default settings
  const nonDefaultSettings = useMemo(() => {
    const diff: Record<string, any> = {};
    if (infill !== DEFAULT_SETTINGS.infill) diff['Infill'] = `${infill}%`;
    if (layerHeight !== DEFAULT_SETTINGS.layerHeight) diff['Layer Height'] = `${layerHeight}mm`;
    if (material !== DEFAULT_SETTINGS.material) diff['Material'] = material;
    if (supports !== DEFAULT_SETTINGS.supports) {
      diff['Supports'] = supports === 'none' ? 'None' : supports === 'tree' ? 'Tree' : 'Default (Operator Decides)';
    }
    return diff;
  }, [infill, layerHeight, material, supports]);

  const hasNonDefaultSettings = Object.keys(nonDefaultSettings).length > 0;

  // Validate Purdue domain
  const handleEmailChange = (val: string) => {
    setEmail(val);
    setEmailError(null);
    setCodeSent(false);
    setIsVerified(false);
    setDevCodeTip(null);
  };

  const isPurdueDomain = (addr: string) => {
    return /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@([a-zA-Z0-9-]+\.)*purdue\.edu$/i.test(addr.trim());
  };

  // 1. Send 6-digit code
  const handleSendCode = async () => {
    const cleanEmail = email.trim().toLowerCase();
    if (!cleanEmail) {
      setEmailError('Please enter your Purdue email address.');
      return;
    }

    if (!isPurdueDomain(cleanEmail)) {
      setEmailError('Submission rejected: Only @purdue.edu email addresses are authorized to submit 3D print jobs.');
      return;
    }

    setSendingCode(true);
    setEmailError(null);
    setCodeError(null);

    try {
      const res = await fetch('/api/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: cleanEmail }),
      });

      const data = await res.json();
      if (!res.ok) {
        setEmailError(data.error || 'Failed to send verification code.');
      } else {
        setCodeSent(true);
        if (data.devCode) {
          setDevCodeTip(data.devCode);
        }
      }
    } catch (err: any) {
      setEmailError('Network error connecting to verification service.');
    } finally {
      setSendingCode(false);
    }
  };

  // 2. Verify 6-digit code
  const handleVerifyCode = async () => {
    const cleanCode = code.trim();
    if (cleanCode.length !== 6) {
      setCodeError('Please enter all 6 digits of your verification code.');
      return;
    }

    setVerifyingCode(true);
    setCodeError(null);

    try {
      const res = await fetch('/api/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email.trim().toLowerCase(), code: cleanCode }),
      });

      const data = await res.json();
      if (!res.ok || !data.valid) {
        setCodeError(data.error || "Code doesn't match. Please try again.");
      } else {
        setIsVerified(true);
        setCodeError(null);
      }
    } catch (err: any) {
      setCodeError('Network error verifying code.');
    } finally {
      setVerifyingCode(false);
    }
  };

  // 3. Final Submit
  const handleSubmitJob = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) {
      alert('Please select an STL file to print.');
      return;
    }

    if (!isVerified) {
      // If code was entered but verify button wasn't clicked yet, try verifying now
      if (codeSent && code.trim().length === 6) {
        await handleVerifyCode();
      } else {
        setEmailError('Please verify your @purdue.edu email address before submitting.');
        return;
      }
    }

    setSubmitting(true);

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('email', email.trim().toLowerCase());
      formData.append('code', code.trim());
      formData.append('title', title.trim() || file.name.replace(/\.stl$/i, ''));
      formData.append('infill', String(infill));
      formData.append('layerHeight', String(layerHeight));
      formData.append('material', material);
      formData.append('supports', supports);
      formData.append('notes', notes.trim());

      const res = await fetch('/api/jobs', {
        method: 'POST',
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to submit print job.');
      } else {
        setSubmittedJob(data.job);
        onJobSubmitted();
      }
    } catch (err) {
      alert('Network error submitting job.');
    } finally {
      setSubmitting(false);
    }
  };

  // Reset form for another submission
  const resetForm = () => {
    setFile(null);
    setTitle('');
    setNotes('');
    setInfill(DEFAULT_SETTINGS.infill);
    setLayerHeight(DEFAULT_SETTINGS.layerHeight);
    setMaterial(DEFAULT_SETTINGS.material);
    setSupports(DEFAULT_SETTINGS.supports);
    setEmail('');
    setCode('');
    setCodeSent(false);
    setIsVerified(false);
    setSubmittedJob(null);
    setDevCodeTip(null);
  };

  if (submittedJob) {
    return (
      <div className="max-w-2xl mx-auto py-12 px-4 text-center">
        <div className="w-16 h-16 bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-xl">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <h2 className="text-3xl font-extrabold text-white tracking-tight mb-2">Print Job Added to Queue!</h2>
        <p className="text-slate-400 mb-8 max-w-md mx-auto">
          Your model <strong className="text-amber-300 font-semibold">{submittedJob.title}</strong> is now in line. We will notify{' '}
          <strong className="text-slate-200">{submittedJob.email}</strong> once your print finishes!
        </p>

        <div className="bg-slate-900/60 border border-slate-800 rounded-xl p-6 max-w-md mx-auto text-left mb-8 space-y-3 font-mono text-xs">
          <div className="flex justify-between border-b border-slate-800 pb-2">
            <span className="text-slate-400">Job Reference:</span>
            <span className="text-slate-200">{submittedJob.id}</span>
          </div>
          <div className="flex justify-between border-b border-slate-800 pb-2">
            <span className="text-slate-400">File Name:</span>
            <span className="text-slate-200 truncate max-w-[200px]">{submittedJob.fileName}</span>
          </div>
          <div className="flex justify-between border-b border-slate-800 pb-2">
            <span className="text-slate-400">Non-Default Settings:</span>
            <span className="text-amber-300 font-bold">
              {Object.keys(submittedJob.settingsDiff || {}).length > 0
                ? JSON.stringify(submittedJob.settingsDiff)
                : 'None (Standard Defaults)'}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-400">Status:</span>
            <span className="px-2 py-0.5 rounded bg-amber-500/10 text-[#CEB888] font-bold uppercase">
              {submittedJob.status}
            </span>
          </div>
        </div>

        <div className="flex justify-center gap-4">
          <button
            onClick={() => onJobSubmitted()}
            className="px-6 py-2.5 rounded-lg bg-[#CEB888] text-slate-950 font-bold text-sm hover:bg-[#d6c499] transition-all shadow-lg shadow-amber-500/10"
          >
            View Live Queue
          </button>
          <button
            onClick={resetForm}
            className="px-6 py-2.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-300 hover:text-white font-medium text-sm transition-all"
          >
            Submit Another Print
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto py-8 px-4 sm:px-6">
      <div className="mb-8">
        <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight">Submit 3D Print</h1>
        <p className="text-sm text-slate-400 mt-1">
          Upload your STL file, adjust settings (only non-default settings are stored), and verify your Purdue email.
        </p>
      </div>

      <form onSubmit={handleSubmitJob} className="space-y-8">
        {/* Step 1: STL File Upload */}
        <section className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#CEB888] text-slate-950 text-xs font-bold flex items-center justify-center">
                1
              </span>
              <h2 className="text-lg font-bold text-slate-100">STL 3D Model File</h2>
            </div>
            {file && (
              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 rounded-full flex items-center gap-1">
                <CheckCircle2 className="w-3 h-3" />
                {(file.size / 1024).toFixed(1)} KB loaded
              </span>
            )}
          </div>

          {!file ? (
            <label className="border-2 border-dashed border-slate-700 hover:border-[#CEB888]/60 bg-slate-950/40 hover:bg-slate-900/50 rounded-xl p-8 flex flex-col items-center justify-center cursor-pointer transition-all group">
              <input
                type="file"
                accept=".stl"
                className="hidden"
                onChange={(e) => {
                  if (e.target.files && e.target.files[0]) {
                    const f = e.target.files[0];
                    setFile(f);
                    if (!title) {
                      setTitle(f.name.replace(/\.stl$/i, ''));
                    }
                  }
                }}
              />
              <div className="w-12 h-12 rounded-xl bg-amber-500/10 border border-amber-500/20 text-[#CEB888] flex items-center justify-center mb-3 group-hover:scale-110 transition-transform">
                <UploadCloud className="w-6 h-6" />
              </div>
              <p className="text-sm font-semibold text-slate-200">
                Click to browse or drag and drop your <span className="text-[#CEB888]">.STL</span> file here
              </p>
              <p className="text-xs text-slate-400 mt-1">Binary or ASCII STL · Up to 50MB</p>
            </label>
          ) : (
            <div className="space-y-4">
              <STLViewer file={file} />
              <div className="flex items-center justify-between bg-slate-950/60 border border-slate-800 rounded-xl p-3">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-amber-500/10 text-[#CEB888] flex items-center justify-center">
                    <FileCode className="w-4 h-4" />
                  </div>
                  <div>
                    <p className="text-xs font-semibold text-slate-200 truncate max-w-[280px]">{file.name}</p>
                    <p className="text-[11px] text-slate-400 font-mono">{(file.size / 1024).toFixed(1)} KB</p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFile(null)}
                  className="text-xs text-red-400 hover:text-red-300 font-medium px-2 py-1 rounded bg-red-500/10 hover:bg-red-500/20 transition-colors"
                >
                  Change File
                </button>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1">Part / Project Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Robot Motor Bracket"
                  className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#CEB888]"
                />
              </div>
            </div>
          )}
        </section>

        {/* Step 2: Basic Print Settings & Non-Default Calculation */}
        <section className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#CEB888] text-slate-950 text-xs font-bold flex items-center justify-center">
                2
              </span>
              <h2 className="text-lg font-bold text-slate-100">Print Settings</h2>
            </div>
            <span className="text-xs text-slate-400">Defaults are marked</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5 mb-6">
            {/* Infill */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-2">
                Infill Percentage: <span className="text-[#CEB888] font-bold font-mono">{infill}%</span>
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {[15, 20, 30, 50].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setInfill(val)}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition-all ${
                      infill === val
                        ? 'bg-[#CEB888] text-slate-950 border-[#CEB888] font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    {val}% {val === DEFAULT_SETTINGS.infill && <span className="text-[10px] opacity-75">(Def)</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Layer Height */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-2">
                Layer Height: <span className="text-[#CEB888] font-bold font-mono">{layerHeight} mm</span>
              </label>
              <div className="grid grid-cols-4 gap-1.5">
                {[0.12, 0.16, 0.20, 0.28].map((val) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setLayerHeight(val)}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition-all ${
                      layerHeight === val
                        ? 'bg-[#CEB888] text-slate-950 border-[#CEB888] font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    {val} {val === DEFAULT_SETTINGS.layerHeight && <span className="text-[10px] opacity-75">(Def)</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Material - Only PLA Available */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-2">
                Filament Material: <span className="text-[#CEB888] font-bold">PLA</span>
              </label>
              <div className="bg-slate-950 border border-slate-800 rounded-lg p-2.5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="w-2.5 h-2.5 rounded-full bg-emerald-400"></span>
                  <span className="text-xs font-bold text-slate-100 font-mono">PLA</span>
                  <span className="text-[11px] text-slate-400">Standard</span>
                </div>
                <span className="text-[10px] font-mono font-semibold px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  Only Material Available
                </span>
              </div>
            </div>

            {/* Supports */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-2">
                Support Structures:{' '}
                <span className="text-[#CEB888] font-bold">
                  {supports === 'default'
                    ? 'Default (Operator Decides)'
                    : supports === 'none'
                    ? 'None'
                    : 'Tree'}
                </span>
              </label>
              <div className="grid grid-cols-3 gap-1.5">
                {[
                  { id: 'none', label: 'None' },
                  { id: 'default', label: 'Default (Operator Decides)' },
                  { id: 'tree', label: 'Tree' },
                ].map((sup) => (
                  <button
                    key={sup.id}
                    type="button"
                    onClick={() => setSupports(sup.id)}
                    className={`py-1.5 px-2 rounded-lg text-xs font-medium border transition-all text-center ${
                      supports === sup.id
                        ? 'bg-[#CEB888] text-slate-950 border-[#CEB888] font-bold'
                        : 'bg-slate-950 border-slate-800 text-slate-300 hover:border-slate-700'
                    }`}
                  >
                    <span className="block truncate">{sup.label}</span>
                    {sup.id === DEFAULT_SETTINGS.supports && (
                      <span className="text-[10px] block opacity-75 font-normal">(Def)</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Non-Default Settings Diff Card */}
          <div className="bg-slate-950 border border-slate-800 rounded-xl p-4">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-bold text-slate-300 uppercase tracking-wider font-mono">
                Database Stored Settings (Non-Default Overrides)
              </span>
              <span className="text-[11px] font-mono text-slate-500">
                {hasNonDefaultSettings ? 'Customized' : 'Pure Defaults'}
              </span>
            </div>
            
            {hasNonDefaultSettings ? (
              <div className="flex flex-wrap gap-2 mt-2">
                {Object.entries(nonDefaultSettings).map(([key, val]) => (
                  <span
                    key={key}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono text-xs font-bold"
                  >
                    ⚡ {key}: {val}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 font-mono mt-1">
                ✓ All settings match standard defaults. No overrides will need to be stored.
              </p>
            )}
          </div>
        </section>

        {/* Step 3: Purdue Email Verification */}
        <section className="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 backdrop-blur-sm">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <span className="w-6 h-6 rounded-full bg-[#CEB888] text-slate-950 text-xs font-bold flex items-center justify-center">
                3
              </span>
              <h2 className="text-lg font-bold text-slate-100">Purdue Email Verification</h2>
            </div>
            {isVerified && (
              <span className="text-xs font-mono text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 px-2.5 py-1 rounded-full flex items-center gap-1.5 font-bold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Verified
              </span>
            )}
          </div>

          <div className="space-y-4">
            {/* Email Field */}
            <div>
              <label className="block text-xs font-semibold text-slate-300 mb-1">
                Enter your @purdue.edu email address
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-500">
                    <Mail className="w-4 h-4" />
                  </div>
                  <input
                    type="email"
                    value={email}
                    disabled={isVerified}
                    onChange={(e) => handleEmailChange(e.target.value)}
                    placeholder="alias@purdue.edu"
                    className={`w-full bg-slate-950 border rounded-lg pl-9 pr-3 py-2 text-sm text-slate-100 placeholder:text-slate-600 focus:outline-none ${
                      emailError
                        ? 'border-red-500/60 focus:border-red-500'
                        : isVerified
                        ? 'border-emerald-500/40 bg-emerald-950/10'
                        : 'border-slate-800 focus:border-[#CEB888]'
                    }`}
                  />
                </div>

                {!isVerified && (
                  <button
                    type="button"
                    disabled={sendingCode || !email}
                    onClick={handleSendCode}
                    className="px-4 py-2 bg-[#CEB888] hover:bg-[#d6c499] disabled:bg-slate-800 disabled:text-slate-500 text-slate-950 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 shrink-0"
                  >
                    {sendingCode ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Sending...
                      </>
                    ) : codeSent ? (
                      'Resend Code'
                    ) : (
                      'Send Code'
                    )}
                  </button>
                )}
              </div>

              {/* Rejection Message if not purdue.edu */}
              {emailError && (
                <div className="flex items-start gap-2 mt-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 p-2.5 rounded-lg">
                  <AlertTriangle className="w-4 h-4 shrink-0 text-red-400 mt-0.5" />
                  <span>{emailError}</span>
                </div>
              )}
            </div>

            {/* Dev mode code helper banner for effortless testing */}
            {devCodeTip && !isVerified && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg p-2.5 text-xs text-amber-300 flex items-center justify-between">
                <span>
                  <strong>Dev Mode Code:</strong> <code className="font-mono font-bold text-sm bg-amber-500/20 px-1.5 py-0.5 rounded">{devCodeTip}</code>
                </span>
                <button
                  type="button"
                  onClick={() => setCode(devCodeTip)}
                  className="text-[11px] underline hover:text-white"
                >
                  Auto-fill
                </button>
              </div>
            )}

            {/* 6-Digit Code Input Section */}
            {codeSent && !isVerified && (
              <div className="p-4 bg-slate-950/80 border border-slate-800 rounded-xl space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                    <KeyRound className="w-3.5 h-3.5 text-[#CEB888]" />
                    Enter the 6-digit code sent to your email
                  </label>
                  <span className="text-[11px] text-slate-500 font-mono">Expires in 15 min</span>
                </div>

                <div className="flex gap-2">
                  <input
                    type="text"
                    maxLength={6}
                    value={code}
                    onChange={(e) => {
                      setCode(e.target.value.replace(/\D/g, ''));
                      setCodeError(null);
                    }}
                    placeholder="123456"
                    className="w-40 bg-slate-900 border border-slate-700 text-center font-mono font-bold text-lg tracking-widest text-[#CEB888] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[#CEB888]"
                  />
                  <button
                    type="button"
                    disabled={verifyingCode || code.length !== 6}
                    onClick={handleVerifyCode}
                    className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:bg-slate-800 disabled:text-slate-500 text-white text-xs font-bold rounded-lg transition-all flex items-center gap-1.5"
                  >
                    {verifyingCode ? (
                      <>
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                        Verifying...
                      </>
                    ) : (
                      'Verify Code'
                    )}
                  </button>
                </div>

                {/* Code Mismatch Error message */}
                {codeError && (
                  <div className="flex items-center gap-2 text-xs text-red-400 bg-red-500/10 border border-red-500/20 p-2 rounded-lg">
                    <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                    <span>{codeError}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Submit Button */}
        <div>
          <button
            type="submit"
            disabled={!file || !isVerified || submitting}
            className={`w-full py-4 rounded-xl font-bold text-base transition-all flex items-center justify-center gap-2 shadow-xl ${
              !file || !isVerified || submitting
                ? 'bg-slate-800 text-slate-500 cursor-not-allowed'
                : 'bg-[#CEB888] hover:bg-[#d6c499] text-slate-950 shadow-amber-500/10'
            }`}
          >
            {submitting ? (
              <>
                <RefreshCw className="w-5 h-5 animate-spin" />
                Uploading STL & Adding to Queue...
              </>
            ) : !file ? (
              'Upload an STL file to continue'
            ) : !isVerified ? (
              'Verify Purdue email to submit'
            ) : (
              <>
                <span>Submit to Print Queue</span>
                <ArrowRight className="w-5 h-5" />
              </>
            )}
          </button>
        </div>
      </form>
    </div>
  );
};
