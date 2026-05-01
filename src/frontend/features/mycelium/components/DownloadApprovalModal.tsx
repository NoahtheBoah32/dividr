import React, { useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useDownloadApprovalStore } from '../stores/downloadApprovalStore';

export function DownloadApprovalModal() {
  const pending = useDownloadApprovalStore((s) => s.pending);
  const approve = useDownloadApprovalStore((s) => s.approve);
  const approveAll = useDownloadApprovalStore((s) => s.approveAll);
  const deny = useDownloadApprovalStore((s) => s.deny);

  const item = pending[0];

  const handleDeny = useCallback(() => { if (item) deny(item.id); }, [item, deny]);
  const handleAllow = useCallback(() => { if (item) approve(item.id); }, [item, approve]);
  const handleAllowAll = useCallback(() => { if (item) approveAll(item.id); }, [item, approveAll]);
  const handleView = useCallback(() => {
    if (item) window.electronAPI.showItemInFolder(item.filePath);
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); handleDeny(); }
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAllow(); }
      if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); handleAllowAll(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [item, handleDeny, handleAllow, handleAllowAll]);

  if (!item) return null;

  const displayUrl = item.sourceUrl.length > 60
    ? item.sourceUrl.slice(0, 57) + '…'
    : item.sourceUrl;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm pointer-events-auto">
      <div
        className="w-[440px] rounded-xl border border-white/[0.1] shadow-2xl overflow-hidden"
        style={{ background: '#1a1a1a', fontFamily: 'Inter, system-ui, sans-serif' }}
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-4">
          <p className="text-sm font-semibold text-zinc-100 mb-1">Allow EDITH to use this download?</p>
          <p className="text-[12px] text-zinc-500 leading-relaxed">
            EDITH downloaded a clip from{' '}
            <span className="text-zinc-400 font-mono text-[11px]">{displayUrl}</span>.
            Approve to add it to your media library.
          </p>
        </div>

        {/* File path block */}
        <div className="mx-5 mb-4 rounded-md border border-white/[0.06] bg-black/40 px-3 py-2">
          <p className="text-[11px] font-mono text-zinc-400 break-all leading-relaxed">
            {item.filePath}
          </p>
        </div>

        {/* Buttons */}
        <div
          className="flex items-center border-t border-white/[0.06]"
          style={{ background: '#141414' }}
        >
          {/* Deny */}
          <button
            onClick={handleDeny}
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors border-r border-white/[0.06]"
          >
            Deny
            <kbd className="text-[10px] text-zinc-700 border border-white/[0.08] rounded px-1 py-0.5 font-mono">esc</kbd>
          </button>

          {/* Allow */}
          <button
            onClick={handleAllow}
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] font-medium text-white hover:bg-white/[0.04] transition-colors border-r border-white/[0.06]"
            style={{ color: '#a3b862' }}
          >
            Allow
            <kbd className="text-[10px] border border-white/[0.08] rounded px-1 py-0.5 font-mono" style={{ color: '#6b7c3a' }}>↵</kbd>
          </button>

          {/* Allow all */}
          <button
            onClick={handleAllowAll}
            className="flex-1 flex items-center justify-center gap-1.5 py-3 text-[12px] text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.03] transition-colors border-r border-white/[0.06]"
          >
            Always allow
            <kbd className="text-[10px] text-zinc-700 border border-white/[0.08] rounded px-1 py-0.5 font-mono">⇧↵</kbd>
          </button>

          {/* View */}
          <button
            onClick={handleView}
            className="flex-1 flex items-center justify-center py-3 text-[12px] text-zinc-500 hover:text-zinc-300 hover:bg-white/[0.03] transition-colors"
          >
            View
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
