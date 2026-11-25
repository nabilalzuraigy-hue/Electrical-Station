import React, { useMemo, useState } from 'react';
import JSZip from 'jszip';
import { Check, Copy, Download, FileCode2 } from 'lucide-react';

const flutterFilesMap = import.meta.glob('/flutter_app/**/*', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const webFilesMap = import.meta.glob(
  [
    '/index.html',
    '/package.json',
    '/server.ts',
    '/.env.example',
    '/tsconfig.json',
    '/vite.config.ts',
    '/firebase.json',
    '/firestore.rules',
    '/metadata.json',
    '/src/**/*.ts',
    '/src/**/*.tsx',
    '/src/**/*.css',
  ],
  {
    query: '?raw',
    import: 'default',
    eager: true,
  },
) as Record<string, string>;


export const FlutterCodeExplorer: React.FC = () => {
  const filePaths = useMemo(
    () => Object.keys(flutterFilesMap).sort(),
    [],
  );
  const [selectedPath, setSelectedPath] = useState<string>(
    filePaths[0] ?? '/flutter_app/pubspec.yaml',
  );
  const [copied, setCopied] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [downloadingWebZip, setDownloadingWebZip] = useState(false);

  const selectedContent = flutterFilesMap[selectedPath] ?? '';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(selectedContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownloadZip = async () => {
    setDownloadingZip(true);
    try {
      const zip = new JSZip();
      for (const [fullPath, content] of Object.entries(flutterFilesMap)) {
        const relativePath = fullPath.replace(/^\/flutter_app\//, '');
        zip.file(relativePath, content);
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'yemen_power_station_flutter.zip';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingZip(false);
    }
  };

  const handleDownloadWebZip = async () => {
    setDownloadingWebZip(true);
    try {
      const zip = new JSZip();
      for (const [fullPath, content] of Object.entries(webFilesMap)) {
        const relativePath = fullPath.replace(/^\//, '');
        zip.file(relativePath, content);
      }
      zip.file(
        '.firebaserc',
        JSON.stringify(
          { projects: { default: 'electricity-station-f5a90' } },
          null,
          2,
        ),
      );

      const blob = await zip.generateAsync({ type: 'blob' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'electricity_station_web_firebase.zip';
      a.click();
      URL.revokeObjectURL(url);
    } finally {
      setDownloadingWebZip(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4 border-b border-slate-200 pb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            حزمة الكود والتحميل (Flutter + مشروع الويب للنشر)
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            يمكنك تحميل مشروع الويب المربوط بـ Firebase مباشرة لرفعه إلى Cloud Shell، أو تحميل مشروع تطبيق Flutter الكامل.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleDownloadWebZip}
            disabled={downloadingWebZip}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-slate-900 hover:bg-slate-800 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            {downloadingWebZip
              ? 'جاري تجهيز مشروع الويب...'
              : 'تحميل مشروع الويب للنشر (.zip)'}
          </button>

          <button
            type="button"
            onClick={handleDownloadZip}
            disabled={downloadingZip}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-teal-700 hover:bg-teal-800 text-white text-sm font-medium rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-4 h-4" />
            {downloadingZip
              ? 'جاري تجهيز الملف...'
              : `تحميل مشروع Flutter (.zip · ${filePaths.length} ملف)`}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <aside className="lg:col-span-4 bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 text-xs font-bold text-slate-700">
            هيكل المشروع (/flutter_app)
          </div>
          <div className="divide-y divide-slate-100 max-h-[620px] overflow-y-auto" dir="ltr">
            {filePaths.map((path) => {
              const active = path === selectedPath;
              const shortName = path.replace('/flutter_app/', '');
              return (
                <button
                  key={path}
                  type="button"
                  onClick={() => setSelectedPath(path)}
                  className={`w-full text-left px-3.5 py-2.5 text-xs font-mono-nums flex items-center gap-2 transition-colors cursor-pointer ${
                    active
                      ? 'bg-teal-50 text-teal-900 font-semibold'
                      : 'text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <FileCode2 className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                  <span className="truncate">{shortName}</span>
                </button>
              );
            })}
          </div>
        </aside>

        <section className="lg:col-span-8 bg-slate-950 border border-slate-800 rounded-xl overflow-hidden">
          <div
            className="px-4 py-3 bg-slate-900 border-b border-slate-800 flex items-center justify-between gap-3"
            dir="ltr"
          >
            <span className="text-xs font-mono-nums text-slate-300 truncate">
              {selectedPath}
            </span>
            <button
              type="button"
              onClick={handleCopy}
              className="px-3 py-1.5 text-xs font-medium text-slate-200 bg-slate-800 hover:bg-slate-700 rounded-md inline-flex items-center gap-1.5 shrink-0 cursor-pointer"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-teal-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre
            dir="ltr"
            className="p-4 text-xs font-mono-nums text-slate-100 overflow-x-auto max-h-[600px] leading-relaxed"
          >
            <code>{selectedContent}</code>
          </pre>
        </section>
      </div>
    </div>
  );
};
