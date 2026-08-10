'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * In-browser Excel engine (Univer) for .xlsx / .csv preview.
 * Loads only when a spreadsheet is opened — keeps the rest of the app light.
 */
export function ExcelPreview({ url, filename }: { url: string; filename: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let disposeUniver: (() => void) | null = null;

    const run = async () => {
      setLoading(true);
      setError(null);

      try {
        const [
          { createUniver, LocaleType, mergeLocales },
          { UniverSheetsCorePreset },
          localeMod,
          LuckyExcel,
        ] = await Promise.all([
          import('@univerjs/presets'),
          import('@univerjs/preset-sheets-core'),
          import('@univerjs/preset-sheets-core/locales/en-US'),
          import('@mertdeveci55/univer-import-export'),
        ]);

        await import('@univerjs/preset-sheets-core/lib/index.css');

        if (disposed || !hostRef.current) return;

        const response = await fetch(url);
        if (!response.ok) throw new Error('Could not load file');
        const blob = await response.blob();
        const file = new File([blob], filename, {
          type: blob.type || guessMime(filename),
        });

        const workbookData = await transformToUniver(
          LuckyExcel.default,
          file,
          filename,
        );

        if (disposed || !hostRef.current) return;

        hostRef.current.replaceChildren();

        const { univerAPI } = createUniver({
          locale: LocaleType.EN_US,
          locales: {
            [LocaleType.EN_US]: mergeLocales(localeMod.default),
          },
          presets: [
            UniverSheetsCorePreset({
              container: hostRef.current,
              // Keep the spreadsheet chrome; drop the app header ribbon noise
              // so the modal stays focused on the sheet itself.
              header: false,
              toolbar: true,
              formulaBar: true,
              footer: {
                sheetBar: true,
                statisticBar: true,
                menus: true,
                zoomSlider: true,
              },
              contextMenu: true,
            }),
          ],
        });

        univerAPI.createWorkbook(workbookData);
        disposeUniver = () => {
          univerAPI.dispose();
        };

        if (!disposed) setLoading(false);
      } catch (err) {
        if (!disposed) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      }
    };

    void run();

    return () => {
      disposed = true;
      disposeUniver?.();
      disposeUniver = null;
      host.replaceChildren();
    };
  }, [url, filename]);

  return (
    <div className="relative flex h-[min(70vh,640px)] min-h-0 flex-col overflow-hidden rounded-md border border-rule">
      {loading ? (
        <p className="text-ink-muted absolute inset-0 z-10 flex items-center justify-center bg-panel/80 text-[13px]">
          Loading spreadsheet…
        </p>
      ) : null}
      {error ? (
        <p className="text-alert absolute inset-0 z-10 flex items-center justify-center bg-panel p-4 text-[13px]">
          {error}
        </p>
      ) : null}
      <div ref={hostRef} className="h-full min-h-0 w-full flex-1" />
    </div>
  );
}

type LuckyExcelApi = {
  transformExcelToUniver: (
    file: File,
    callback?: (data: object) => void,
    errorHandler?: (err: Error) => void,
  ) => Promise<void>;
  transformCsvToUniver: (
    file: File,
    callback?: (data: object) => void,
    errorHandler?: (err: Error) => void,
  ) => void;
};

function transformToUniver(
  LuckyExcel: LuckyExcelApi,
  file: File,
  filename: string,
): Promise<object> {
  const isCsv = filename.toLowerCase().endsWith('.csv');
  return new Promise((resolve, reject) => {
    const onOk = (data: object) => resolve(data);
    const onErr = (err: Error) => reject(err);
    if (isCsv) {
      LuckyExcel.transformCsvToUniver(file, onOk, onErr);
    } else {
      void LuckyExcel.transformExcelToUniver(file, onOk, onErr);
    }
  });
}

function guessMime(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.csv')) return 'text/csv';
  if (lower.endsWith('.xls')) return 'application/vnd.ms-excel';
  return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
}
