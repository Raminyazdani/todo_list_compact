"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { useSearchParams } from "next/navigation";
import {
  ArrowUpRight,
  Download,
  FileText,
  History,
  Link2,
  LockKeyhole,
  Upload,
} from "lucide-react";
import type {
  CommandName,
  FileDTO,
  MutationResult,
  PageDTO,
  TaskDTO,
} from "@/shared/contracts";
import { query, useQuery, clearQueryCache } from "./api";
import { useLocale } from "./locale";
import {
  Button,
  Empty,
  Field,
  Modal,
  QueryState,
  SectionHeading,
} from "@/components/ui";
import {
  boundedTextDiff,
  executeArchiveHttp,
  isPrivateFileProvider,
  loadFilePreview,
  prepareBulkArchive,
  runBulkArchive,
  versionMetadataDiff,
  type ArchivePreview,
  type BulkArchiveRow,
  type SafePreview,
} from "./file-tools";

type Action = (
  name: CommandName,
  input: Record<string, unknown>,
  revision?: number,
) => Promise<MutationResult | null>;

function FileAnnotations({ file, action }: { file: FileDTO; action: Action }) {
  const { t } = useLocale();
  const [description, setDescription] = useState(file.description ?? "");
  const [tags, setTags] = useState((file.tags ?? []).join("\n"));
  const [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  return (
    <form
      className="form-grid"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setNotice("");
        const labels = tags
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean);
        try {
          if (
            labels.length > 50 ||
            labels.some(
              (value) =>
                value.length > 80 || /[\u0000-\u001f\u007f]/.test(value),
            )
          )
            throw new Error(
              t(
                "حداکثر ۵۰ برچسب کوتاه، هرکدام در یک خط، مجاز است.",
                "Use at most 50 short tags, one per line.",
              ),
            );
          const result = await action(
            "file_metadata_update",
            { file_id: file.file_id, description, tags: labels },
            file.revision,
          );
          if (!result) {
            setNotice(
              t(
                "ذخیره تأیید نشده؛ پیام خطا را بررسی و همین تغییر را دوباره امتحان کن.",
                "Save is unconfirmed. Check the error and retry the same edit.",
              ),
            );
            return;
          }
          clearQueryCache();
          const fresh = await query<FileDTO>("file_get_metadata", {
            file_id: file.file_id,
          });
          if (
            fresh.description !== description ||
            JSON.stringify(fresh.tags ?? []) !== JSON.stringify(labels) ||
            fresh.revision < result.version
          )
            throw new Error(
              t(
                "نتیجهٔ ذخیره هنوز با خواندن دوباره تأیید نشده است.",
                "Saved annotations are not yet confirmed by readback.",
              ),
            );
          setNotice(
            t(
              "توضیح و برچسب‌ها ذخیره و دوباره بررسی شدند.",
              "Annotations saved and verified.",
            ),
          );
        } catch (cause) {
          setNotice(
            cause instanceof Error
              ? cause.message
              : t("ذخیره تأیید نشده", "Save unconfirmed"),
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <SectionHeading title={t("توضیح و برچسب‌ها", "Description & tags")} />
      <Field label={t("توضیح فایل", "File description")}>
        <textarea
          maxLength={10000}
          rows={3}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </Field>
      <Field
        label={t("برچسب‌های فایل؛ هر برچسب یک خط", "File tags; one per line")}
      >
        <textarea
          rows={3}
          maxLength={4100}
          value={tags}
          onChange={(event) => setTags(event.target.value)}
        />
      </Field>
      <p className="small muted">
        {t(
          "این یادداشت‌ها فقط در برنامه ذخیره می‌شوند؛ محتوای اصلی و نسخه‌ها حفظ می‌شوند.",
          "These annotations are saved in the app; original bytes and versions are preserved.",
        )}
      </p>
      <Button type="submit" disabled={busy} variant="primary">
        {t("ذخیرهٔ توضیح و برچسب‌ها", "Save description & tags")}
      </Button>
      {notice && (
        <p role="status" className="small">
          {notice}
        </p>
      )}
    </form>
  );
}

/** React escapes plaintext; it is never interpreted as an HTML document. */
export function SafeTextPreview({ text }: { text: string }) {
  return (
    <pre
      style={{
        maxHeight: 320,
        overflow: "auto",
        whiteSpace: "pre-wrap",
        overflowWrap: "anywhere",
      }}
    >
      {text}
    </pre>
  );
}
export function FileWorkspace({
  action,
  onOpen,
}: {
  action: Action;
  onOpen: (id: string) => void;
}) {
  const { t } = useLocale();
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [selection, setSelection] = useState<
    Record<string, { file_id: string; title: string }>
  >({});
  const [bulk, setBulk] = useState<BulkArchiveRow[] | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false),
    [bulkConfirmed, setBulkConfirmed] = useState(false);
  const [bytePreview, setBytePreview] = useState<SafePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false),
    [previewError, setPreviewError] = useState("");
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const imageUrlRef = useRef<string | null>(null),
    previewGeneration = useRef(0);
  const [compareLeft, setCompareLeft] = useState(""),
    [compareRight, setCompareRight] = useState("");
  const [comparison, setComparison] = useState<{
    metadata: ReturnType<typeof versionMetadataDiff>;
    text: ReturnType<typeof boundedTextDiff> | null;
    note: string;
  } | null>(null);
  const [compareBusy, setCompareBusy] = useState(false);
  const [external, setExternal] = useState(false);
  const [picked, setSelected] = useState<FileDTO | null>(null);
  const params = useSearchParams();
  const linkedFileId = params.get("file");
  const [initialFileId, setInitialFileId] = useState<string | null>(
    () => linkedFileId,
  );
  const activeFileId = picked?.file_id ?? initialFileId;
  const [versionCursor, setVersionCursor] = useState<string | null>(null);
  const metadata = useQuery<FileDTO>(
    "file_get_metadata",
    { file_id: activeFileId ?? "" },
    !!activeFileId,
  );
  const selected = metadata.data ?? picked;
  const [taskSearch, setTaskSearch] = useState("");
  const [cursor, setCursor] = useState<string | null>(null);
  const [archive, setArchive] = useState<{
    file_id: string;
    eligible: boolean;
    linked_task_count: number;
    blocked_by: string[];
    reason: string | null;
    revision: number;
  } | null>(null);
  const [pendingUpload, setPendingUpload] = useState<{
    file: File;
    fingerprint: string;
    key: string;
    file_id?: string;
    revision?: number;
  } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const files = useQuery<PageDTO<FileDTO>>("file_search", {
    search,
    tags: tagFilter.trim()
      ? tagFilter
          .split("\n")
          .map((value) => value.trim())
          .filter(Boolean)
      : undefined,
    state: state || undefined,
    limit: 100,
    ...(cursor ? { cursor } : {}),
  });
  const tasks = useQuery<PageDTO<TaskDTO>>(
    "task_search",
    { limit: 100, search: taskSearch || undefined },
    !!activeFileId,
  );
  const capabilities = useQuery<Record<string, unknown>>("system_capabilities");
  const versions = useQuery<PageDTO<FileDTO>>(
    "file_list_versions",
    { file_id: selected?.file_id ?? "", limit: 100, cursor: versionCursor },
    !!selected,
  );
  useEffect(
    () => () => {
      previewGeneration.current++;
      if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    },
    [],
  );
  function clearPreview() {
    previewGeneration.current++;
    setBytePreview(null);
    setPreviewError("");
    setPreviewBusy(false);
    if (imageUrlRef.current) URL.revokeObjectURL(imageUrlRef.current);
    imageUrlRef.current = null;
    setImageUrl(null);
    setComparison(null);
    setCompareLeft("");
    setCompareRight("");
  }
  async function previewFile(file: FileDTO) {
    clearPreview();
    const generation = previewGeneration.current;
    setPreviewBusy(true);
    try {
      const result = await loadFilePreview(file);
      if (generation !== previewGeneration.current) return;
      if (result.kind === "image") {
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(result.bytes)], { type: result.mime_type }),
        );
        imageUrlRef.current = url;
        setImageUrl(url);
      }
      setBytePreview(result);
    } catch {
      if (generation === previewGeneration.current)
        setPreviewError(
          t(
            "پیش‌نمایش محتوا در دسترس نیست؛ اتصال و دسترسی فایل را بررسی کن.",
            "File preview is unavailable. Check the storage connection and file access.",
          ),
        );
    } finally {
      if (generation === previewGeneration.current) setPreviewBusy(false);
    }
  }
  async function compareVersions() {
    const left = versions.data?.items.find(
        (file) => file.file_id === compareLeft,
      ),
      right = versions.data?.items.find(
        (file) => file.file_id === compareRight,
      );
    if (!left || !right || left.file_id === right.file_id) return;
    const generation = previewGeneration.current;
    setCompareBusy(true);
    const metadataDiff = versionMetadataDiff(left, right);
    try {
      const previews =
        isPrivateFileProvider(left.provider) &&
        isPrivateFileProvider(right.provider) &&
        storageConfigured &&
        left.mime_type === "text/plain" &&
        right.mime_type === "text/plain"
          ? await Promise.all([loadFilePreview(left), loadFilePreview(right)])
          : [];
      if (generation !== previewGeneration.current) return;
      const a = previews[0],
        b = previews[1];
      setComparison({
        metadata: metadataDiff,
        text:
          a?.kind === "text" && b?.kind === "text"
            ? boundedTextDiff(a.text, b.text)
            : null,
        note:
          a?.kind === "text" && b?.kind === "text"
            ? a.truncated || b.truncated
              ? t(
                  "متن‌ها به ۳۲ کیلوبایت محدود شده‌اند؛ مقایسهٔ خطوط نیز تا ۳۰۰ خط است.",
                  "Text is limited to 32 KB per version and the comparison to 300 lines.",
                )
              : t(
                  "مقایسهٔ خطوط متن تا ۳۰۰ خط انجام می‌شود.",
                  "Text line comparison is limited to 300 lines.",
                )
            : t(
                "مقایسهٔ فراداده در دسترس است؛ پیش‌نمایش متن این نسخه‌ها در دسترس نیست.",
                "Metadata comparison is available; text previews for these versions are unavailable.",
              ),
      });
    } catch {
      if (generation === previewGeneration.current)
        setComparison({
          metadata: metadataDiff,
          text: null,
          note: t(
            "محتوا خوانده نشد؛ فقط فرادادهٔ ثبت‌شده مقایسه شد.",
            "Bytes could not be read; only registered metadata was compared.",
          ),
        });
    } finally {
      setCompareBusy(false);
    }
  }
  async function bulkPreview() {
    setBulkBusy(true);
    setBulkConfirmed(false);
    try {
      setBulk(
        await prepareBulkArchive(Object.values(selection), (file_id) =>
          query<ArchivePreview>("file_archive_preview", { file_id }),
        ),
      );
    } catch {
      setUploadError(
        t(
          "حداکثر ۲۰ فایل مشخص را انتخاب کن.",
          "Choose at most 20 exact files.",
        ),
      );
    } finally {
      setBulkBusy(false);
    }
  }
  async function commitBulk() {
    if (!bulk || !bulkConfirmed || bulkBusy) return;
    setBulkBusy(true);
    try {
      const result = await runBulkArchive(
        bulk,
        bulkConfirmed,
        async (row) => {
          const accepted = await executeArchiveHttp(row);
          clearQueryCache();
          return accepted;
        },
        (file_id) => query<FileDTO>("file_get_metadata", { file_id }),
        setBulk,
      );
      setBulk(result);
      clearQueryCache();
      window.dispatchEvent(new Event("lifeos:changed"));
      files.refresh();
      metadata.refresh();
    } finally {
      setBulkBusy(false);
    }
  }
  async function executeUpload(intent: NonNullable<typeof pendingUpload>) {
    setUploading(true);
    setUploadError("");
    const form = new FormData();
    form.set("file", intent.file);
    if (intent.file_id) form.set("file_id", intent.file_id);
    try {
      const response = await fetch("/api/v1/files/upload", {
        method: "POST",
        body: form,
        headers: {
          "Idempotency-Key": intent.key,
          ...(intent.revision !== undefined
            ? { "If-Match": String(intent.revision) }
            : {}),
        },
        credentials: "same-origin",
      });
      const result = await response.json();
      if (!response.ok) {
        if (
          response.status >= 400 &&
          response.status < 500 &&
          response.status !== 408
        )
          setPendingUpload(null);
        throw new Error(result.error?.message ?? "Upload failed");
      }
      setPendingUpload(null);
      clearQueryCache();
      window.dispatchEvent(new Event("lifeos:changed"));
      if (result.data?.data?.file_id === result.data?.entity_id)
        setSelected(result.data.data as FileDTO);
      else
        setSelected(
          await query<FileDTO>("file_get_metadata", {
            file_id: result.data.entity_id,
          }),
        );
      files.refresh();
      versions.refresh();
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : String(error));
    } finally {
      setUploading(false);
    }
  }
  async function upload(
    event: React.ChangeEvent<HTMLInputElement>,
    target?: FileDTO,
  ) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (
      file.size > Number(capabilities.data?.max_upload_bytes ?? 4 * 1024 * 1024)
    ) {
      setUploadError(
        t(
          "اندازه فایل از سقف بارگذاری خصوصی بیشتر است.",
          "This file exceeds the private upload size limit.",
        ),
      );
      return;
    }
    setUploading(true);
    try {
      const hash = Array.from(
        new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        ),
      )
        .map((value) => value.toString(16).padStart(2, "0"))
        .join("");
      const fingerprint = `${target?.file_id ?? "new"}:${target?.revision ?? "new"}:${file.name}:${file.type}:${hash}`;
      const intent =
        pendingUpload?.fingerprint === fingerprint
          ? pendingUpload
          : {
              file,
              fingerprint,
              key: crypto.randomUUID(),
              ...(target
                ? { file_id: target.file_id, revision: target.revision }
                : {}),
            };
      setPendingUpload(intent);
      await executeUpload(intent);
    } catch (cause) {
      setUploadError(cause instanceof Error ? cause.message : String(cause));
      setUploading(false);
    }
  }
  const storageConfigured =
    capabilities.data?.storage_configured === true ||
    capabilities.data?.private_storage === true;
  return (
    <>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {t("همهٔ چیزهای مرتبط", "EVERYTHING CONNECTED")}
          </div>
          <h1>{t("فایل‌ها و منابع", "Files & knowledge")}</h1>
          <p>
            {t(
              "نسخه‌ها و پیوندها را نگه دار؛ هیچ منبع اصلی جابه‌جا نمی‌شود.",
              "Keep versions and relationships; original source files stay in place.",
            )}
          </p>
        </div>
        <div className="form-actions">
          <Button onClick={() => setExternal(true)}>
            <Link2 size={16} />
            {t("پیوند منبع", "Link source")}
          </Button>
          <label
            className={`button primary ${!storageConfigured ? "disabled" : ""}`}
            title={
              !storageConfigured
                ? t(
                    "ذخیره‌سازی خصوصی هنوز پیکربندی نشده",
                    "Private storage is not configured",
                  )
                : ""
            }
          >
            <Upload size={16} />
            {uploading
              ? t("در حال بارگذاری…", "Uploading…")
              : t("بارگذاری فایل", "Upload file")}
            <input
              hidden
              type="file"
              disabled={!storageConfigured || uploading}
              onChange={(event) => void upload(event)}
            />
          </label>
        </div>
      </div>
      {!storageConfigured && (
        <p className="connection-notice">
          <LockKeyhole size={15} />
          {t(
            "بارگذاری فایل جدید به اتصال ذخیره‌سازی خصوصی نیاز دارد. منابع Google Drive در جای اصلی خود باقی می‌مانند.",
            "New uploads require configured private storage. Google Drive references remain at their original locations.",
          )}
        </p>
      )}
      {uploadError && (
        <p className="error" role="alert">
          {uploadError}
        </p>
      )}
      {pendingUpload && !uploading && (
        <Button onClick={() => void executeUpload(pendingUpload)}>
          {t(
            "تلاش دوباره برای همان بارگذاری تأییدنشده",
            "Retry the same unconfirmed upload",
          )}
        </Button>
      )}
      <div className="filter-bar">
        <input
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setCursor(null);
          }}
          placeholder={t("جست‌وجوی فایل‌ها…", "Search files…")}
        />
        <Field
          label={t("فیلتر برچسب؛ هر برچسب یک خط", "Filter tags; one per line")}
        >
          <textarea
            rows={1}
            maxLength={4100}
            value={tagFilter}
            onChange={(event) => {
              setTagFilter(event.target.value);
              setCursor(null);
            }}
          />
        </Field>
        <div className="tabs">
          {[
            ["", t("همه", "All")],
            ["Inbox", t("ورودی", "Inbox")],
            ["Active", t("فعال", "Active")],
            ["Old", t("بایگانی", "Archived")],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => {
                setState(value);
                setCursor(null);
              }}
              className={state === value ? "active" : ""}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="form-actions pagination">
        <span className="small muted">
          {files.data?.total ?? "—"}{" "}
          {t("فایل در این محدوده", "files in this scope")}
        </span>
        {cursor && (
          <Button onClick={() => setCursor(null)}>
            {t("صفحهٔ اول", "First page")}
          </Button>
        )}
        {files.data?.next_cursor && (
          <Button onClick={() => setCursor(files.data?.next_cursor ?? null)}>
            {t("صفحهٔ بعد", "Next page")}
          </Button>
        )}
      </div>
      <QueryState {...files} retry={files.refresh} />
      <div className="form-actions">
        <span className="small muted">
          {Object.keys(selection).length}/20{" "}
          {t("فایل انتخاب شده", "selected files")}
        </span>
        <Button
          disabled={!Object.keys(selection).length || bulkBusy}
          onClick={() => void bulkPreview()}
        >
          {t("بررسی بایگانی گروهی", "Review bulk archive")}
        </Button>
        {!!Object.keys(selection).length && (
          <Button onClick={() => setSelection({})}>
            {t("پاک‌کردن انتخاب", "Clear selection")}
          </Button>
        )}
      </div>
      <div className="file-grid">
        {files.data?.items.map((file) => (
          <div key={file.file_id}>
            <label className="check-label">
              <input
                type="checkbox"
                aria-label={t(`انتخاب ${file.title}`, `Select ${file.title}`)}
                checked={!!selection[file.file_id]}
                disabled={
                  !selection[file.file_id] &&
                  Object.keys(selection).length >= 20
                }
                onChange={(event) =>
                  setSelection((current) => {
                    const next = { ...current };
                    if (event.target.checked)
                      next[file.file_id] = {
                        file_id: file.file_id,
                        title: file.title,
                      };
                    else delete next[file.file_id];
                    return next;
                  })
                }
              />
              {t("انتخاب برای بررسی بایگانی", "Select for archive review")}
            </label>
            <button
              className="file-card"
              key={file.file_id}
              onClick={() => {
                clearPreview();
                setVersionCursor(null);
                setSelected(file);
              }}
            >
              <div className="file-art">
                <FileText size={42} />
                <span>
                  {file.original_filename.split(".").pop()?.toUpperCase()}
                </span>
              </div>
              <div className="file-info">
                <strong>{file.title}</strong>
                <small>
                  {file.provider === "google_drive"
                    ? "Google Drive"
                    : t("فایل خصوصی", "Private file")}{" "}
                  ·{" "}
                  {file.size_bytes !== null
                    ? `${Math.round(file.size_bytes / 1024)} KB`
                    : t("اندازه نامشخص", "Size unavailable")}
                </small>
                <span className="chip">{file.state}</span>
                {!!file.tags?.length && <small>{file.tags.join(" · ")}</small>}
              </div>
            </button>
          </div>
        ))}
      </div>
      {!files.loading && !files.data?.items.length && (
        <Empty
          title={t(
            "منابعت اینجا کنار هم می‌مانند",
            "Keep your references together here",
          )}
        />
      )}
      <Modal
        title={t("پیوند یک منبع موجود", "Register an existing source")}
        open={external}
        onOpenChange={setExternal}
      >
        <form
          className="form-grid"
          onSubmit={async (event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const result = await action("file_register_external_link", {
              title: form.get("title"),
              external_url: form.get("url"),
              external_id: form.get("external_id"),
              provider: "google_drive",
              original_filename: form.get("title"),
            });
            if (result) setExternal(false);
          }}
        >
          <Field label={t("عنوان", "Title")}>
            <input required name="title" />
          </Field>
          <Field label={t("پیوند Google Drive", "Google Drive URL")}>
            <input
              required
              name="url"
              type="url"
              dir="ltr"
              placeholder="https://drive.google.com/…"
            />
          </Field>
          <Field label={t("شناسهٔ فایل در Drive", "Drive file ID")}>
            <input name="external_id" required dir="ltr" />
          </Field>
          <Button variant="primary" type="submit">
            {t("ثبت مرجع", "Register reference")}
          </Button>
        </form>
      </Modal>
      <Modal
        title={selected?.title ?? t("جزئیات فایل", "File details")}
        open={!!activeFileId}
        onOpenChange={(value) => {
          if (!value) {
            clearPreview();
            setSelected(null);
            setInitialFileId(null);
            setVersionCursor(null);
          }
        }}
      >
        <QueryState {...metadata} retry={metadata.refresh} />
        {selected && (
          <>
            <div className="file-art large">
              <FileText size={58} />
            </div>
            <dl className="metadata-list">
              <dt>{t("منبع", "Provider")}</dt>
              <dd>
                {selected.provider === "google_drive"
                  ? "Google Drive"
                  : t("فایل خصوصی", "Private file")}
              </dd>
              <dt>{t("نام اصلی", "Original filename")}</dt>
              <dd>{selected.original_filename}</dd>
              <dt>SHA-256</dt>
              <dd className="mono">
                {selected.sha256 ?? t("محاسبه نشده", "Not available")}
              </dd>
              <dt>{t("وضعیت", "State")}</dt>
              <dd>{selected.state}</dd>
            </dl>
            <FileAnnotations
              key={`${selected.file_id}:${selected.revision}`}
              file={selected}
              action={action}
            />
            <SectionHeading
              title={t("پیش‌نمایش امن محتوا", "Safe content preview")}
            />
            {selected.provider === "google_drive" ? (
              <p className="small muted">
                {t(
                  "پیش‌نمایش Drive به دسترسی برنامه نیاز دارد و اکنون در دسترس نیست. می‌توانی منبع اصلی را با حساب Google خود باز کنی.",
                  "Drive byte preview requires an app grant and is currently unavailable. You can open the original source with your Google account.",
                )}
              </p>
            ) : (
              <>
                <Button
                  disabled={!storageConfigured || previewBusy}
                  onClick={() => void previewFile(selected)}
                >
                  {previewBusy
                    ? t("در حال خواندن…", "Reading…")
                    : t("نمایش متن یا تصویر", "Preview text or image")}
                </Button>
                <p className="small muted">
                  {t(
                    "متن ساده تا ۳۲ کیلوبایت و تصویرهای PNG/JPEG/WebP بررسی‌شده نمایش داده می‌شوند. پیش‌نمایش فعال HTML، SVG و PDF اجرا نمی‌شود.",
                    "Plaintext up to 32 KB and validated PNG/JPEG/WebP images are supported. Active HTML, SVG and PDF previews are not run.",
                  )}
                </p>
              </>
            )}
            {previewError && (
              <p role="alert" className="error">
                {previewError}
              </p>
            )}
            {bytePreview?.kind === "text" && (
              <>
                <SafeTextPreview text={bytePreview.text} />
                {bytePreview.truncated && (
                  <p className="small muted">
                    {t(
                      "فقط ابتدای متن نمایش داده می‌شود؛ برای نسخهٔ کامل دریافت فایل را انتخاب کن.",
                      "Only the beginning is shown. Download the full original for the complete text.",
                    )}
                  </p>
                )}
              </>
            )}
            {bytePreview?.kind === "image" && imageUrl && (
              <Image
                unoptimized
                src={imageUrl}
                alt={selected.original_filename}
                width={bytePreview.width}
                height={bytePreview.height}
                style={{ maxWidth: "100%", height: "auto" }}
                onError={() => {
                  setPreviewError(
                    t(
                      "تصویر قابل نمایش نیست.",
                      "The image cannot be displayed.",
                    ),
                  );
                  setBytePreview(null);
                }}
              />
            )}
            {bytePreview?.kind === "unavailable" && (
              <p className="small muted">
                {t(
                  "پیش‌نمایش امن این نوع یا محتوای فایل در دسترس نیست؛ اصل فایل را دریافت کن.",
                  "Safe preview is unavailable for this type or content. Download the original file.",
                )}
              </p>
            )}
            <div className="form-actions">
              {selected.external_url ? (
                <a
                  className="button"
                  target="_blank"
                  rel="noreferrer"
                  href={selected.external_url}
                >
                  <ArrowUpRight size={15} />
                  {t("بازکردن منبع", "Open source")}
                </a>
              ) : (
                <a
                  className="button"
                  href={`/api/v1/files/${encodeURIComponent(selected.file_id)}/download`}
                >
                  <Download size={15} />
                  {t("دریافت فایل", "Download")}
                </a>
              )}
              <Button
                onClick={async () => {
                  if (selected.state === "Old") {
                    const result = await action(
                      "file_restore",
                      { file_id: selected.file_id },
                      selected.revision,
                    );
                    if (result) metadata.refresh();
                  } else {
                    try {
                      const preview = await query<NonNullable<typeof archive>>(
                        "file_archive_preview",
                        { file_id: selected.file_id },
                      );
                      setArchive(preview);
                    } catch (error) {
                      window.dispatchEvent(
                        new CustomEvent("lifeos:error", {
                          detail: String(error),
                        }),
                      );
                    }
                  }
                }}
              >
                {selected.state === "Old"
                  ? t("بازیابی", "Restore")
                  : t("بررسی امکان بایگانی", "Check archive eligibility")}
              </Button>
            </div>
            <SectionHeading title={t("پیوند به یک کار", "Link to a task")} />
            <Field label={t("جست‌وجوی کار مرتبط", "Search for a linked task")}>
              <input
                value={taskSearch}
                onChange={(event) => setTaskSearch(event.target.value)}
                placeholder={t(
                  "جست‌وجو بین همهٔ پروژه‌ها…",
                  "Search across all projects…",
                )}
              />
            </Field>
            <form
              className="form-grid"
              onSubmit={async (event) => {
                event.preventDefault();
                const data = new FormData(event.currentTarget);
                await action(
                  "file_link_to_task",
                  {
                    file_id: selected.file_id,
                    task_id: data.get("task_id"),
                    purpose: data.get("purpose"),
                  },
                  selected.revision,
                );
              }}
            >
              <select
                name="task_id"
                required
                aria-label={t(
                  "انتخاب کار برای فایل",
                  "Choose a task for this file",
                )}
              >
                <option value="">{t("انتخاب کار…", "Choose a task…")}</option>
                {tasks.data?.items.map((task) => (
                  <option key={task.task_id} value={task.task_id}>
                    {task.title}
                  </option>
                ))}
              </select>
              <select
                name="purpose"
                aria-label={t("نقش فایل در کار", "File purpose")}
              >
                {["Input", "Reference", "Output", "Other"].map((value) => (
                  <option key={value}>{value}</option>
                ))}
              </select>
              <Button type="submit">{t("پیوند", "Link")}</Button>
            </form>
            <SectionHeading title={t("نسخه‌ها", "Versions")} />
            <label
              className={`button ${!storageConfigured || !isPrivateFileProvider(selected.provider) || uploading ? "disabled" : ""}`}
            >
              <Upload size={15} />
              {t(
                "بارگذاری نسخهٔ تازه با حفظ اصل",
                "Upload a new version and preserve the original",
              )}
              <input
                type="file"
                hidden
                disabled={
                  !storageConfigured ||
                  !isPrivateFileProvider(selected.provider) ||
                  uploading
                }
                onChange={(event) => void upload(event, selected)}
              />
            </label>
            {selected.provider === "google_drive" && (
              <p className="small muted">
                {t(
                  "مرجع Google Drive و نسخه‌های اصلی آن فقط خواندنی‌اند.",
                  "The Google Drive reference and its original versions are read-only.",
                )}
              </p>
            )}
            <QueryState {...versions} retry={versions.refresh} />
            <div className="form-actions">
              <span className="small muted">
                {versions.data?.items.length ?? 0}/{versions.data?.total ?? "—"}{" "}
                {t("نسخه در این صفحه", "versions on this page")}
              </span>
              {versionCursor && (
                <Button onClick={() => setVersionCursor(null)}>
                  {t("صفحهٔ اول نسخه‌ها", "First version page")}
                </Button>
              )}
              {versions.data?.next_cursor && (
                <Button
                  onClick={() => setVersionCursor(versions.data!.next_cursor)}
                >
                  {t("نسخه‌های بعدی", "Next versions")}
                </Button>
              )}
            </div>
            {(versions.data?.items.length ?? 0) >= 2 && (
              <div className="form-grid">
                <SectionHeading
                  title={t("مقایسهٔ نسخه‌ها", "Compare versions")}
                />
                <Field label={t("نسخهٔ اول", "First version")}>
                  <select
                    value={compareLeft}
                    onChange={(event) => {
                      setCompareLeft(event.target.value);
                      setComparison(null);
                    }}
                  >
                    <option value="">
                      {t("انتخاب نسخه…", "Choose a version…")}
                    </option>
                    {versions.data?.items.map((file, index) => (
                      <option key={file.file_id} value={file.file_id}>
                        {index + 1}. {file.original_filename} ·{" "}
                        {file.sha256?.slice(0, 8) ?? file.state}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("نسخهٔ دوم", "Second version")}>
                  <select
                    value={compareRight}
                    onChange={(event) => {
                      setCompareRight(event.target.value);
                      setComparison(null);
                    }}
                  >
                    <option value="">
                      {t("انتخاب نسخه…", "Choose a version…")}
                    </option>
                    {versions.data?.items.map((file, index) => (
                      <option key={file.file_id} value={file.file_id}>
                        {index + 1}. {file.original_filename} ·{" "}
                        {file.sha256?.slice(0, 8) ?? file.state}
                      </option>
                    ))}
                  </select>
                </Field>
                <Button
                  disabled={
                    !compareLeft ||
                    !compareRight ||
                    compareLeft === compareRight ||
                    compareBusy
                  }
                  onClick={() => void compareVersions()}
                >
                  {t("مقایسهٔ فراداده و متن", "Compare metadata & text")}
                </Button>
                {comparison && (
                  <>
                    <p className="small muted">{comparison.note}</p>
                    {!comparison.metadata.length && (
                      <p className="small muted">
                        {t(
                          "فرادادهٔ انتخاب‌شده تفاوتی ندارد.",
                          "Selected metadata fields match.",
                        )}
                      </p>
                    )}
                    {comparison.metadata.map((diff) => (
                      <div key={diff.field}>
                        <strong>{diff.field}</strong>
                        <SafeTextPreview
                          text={`− ${diff.before}\n+ ${diff.after}`}
                        />
                      </div>
                    ))}
                    {comparison.text && (
                      <>
                        {!comparison.text.lines.length && (
                          <p>
                            {t(
                              "در محدودهٔ خوانده‌شده، خطوط متن یکسان‌اند.",
                              "Text lines match within the inspected range.",
                            )}
                          </p>
                        )}
                        {comparison.text.lines.map((diff) => (
                          <div key={diff.line}>
                            <span className="small muted">
                              {t("خط", "Line")} {diff.line}
                            </span>
                            <SafeTextPreview
                              text={`− ${diff.before}\n+ ${diff.after}`}
                            />
                          </div>
                        ))}
                        {comparison.text.truncated && (
                          <p className="warning">
                            {t(
                              "این مقایسه محدود است؛ برای بررسی کامل، دو نسخهٔ اصلی را دریافت کن.",
                              "This comparison is bounded. Download both originals for a complete review.",
                            )}
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>
            )}
            {versions.data?.items.map((version, index) => (
              <div className="dependency-row" key={version.file_id ?? index}>
                <History size={14} />
                <span>
                  {String(
                    version.original_filename ?? selected.original_filename,
                  )}
                </span>
                <span className="small mono" title={version.sha256 ?? ""}>
                  {version.sha256?.slice(0, 12) ??
                    t("هش ناموجود", "Hash unavailable")}
                </span>
                {isPrivateFileProvider(version.provider) ? (
                  <a
                    className="button"
                    href={`/api/v1/files/${encodeURIComponent(version.file_id)}/download`}
                  >
                    {t("دریافت همین نسخه", "Download this exact version")}
                  </a>
                ) : (
                  version.external_url && (
                    <a
                      className="button"
                      href={version.external_url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {t("منبع اصلی", "Original source")}
                    </a>
                  )
                )}
              </div>
            ))}
          </>
        )}
      </Modal>
      <Modal
        title={t(
          "بررسی و تأیید بایگانی فایل",
          "Review and confirm file archive",
        )}
        open={!!archive}
        onOpenChange={(value) => {
          if (!value) setArchive(null);
        }}
      >
        {archive && (
          <form
            className="form-grid"
            onSubmit={async (event) => {
              event.preventDefault();
              const result = await action(
                "file_archive",
                { file_id: archive.file_id, explicit_user_intent: true },
                archive.revision,
              );
              if (result) {
                setArchive(null);
                metadata.refresh();
              }
            }}
          >
            <p>
              {archive.eligible
                ? t(
                    "تمام کارهای مرتبط بسته‌اند؛ بایگانی این فایل خصوصی مجاز است. محتوا و نسخه‌های آن حفظ می‌شوند.",
                    "All linked tasks are closed. This private file can be archived; its bytes and versions are preserved.",
                  )
                : t(
                    "این فایل فعلاً قابل بایگانی نیست.",
                    "This file cannot be archived at present.",
                  )}
            </p>
            <p className="small muted">
              {archive.linked_task_count} {t("کار مرتبط", "linked tasks")}
            </p>
            {archive.reason && (
              <p className="warning">
                {(
                  {
                    EXTERNALLY_MANAGED: t(
                      "منبع بیرونی فقط خواندنی است",
                      "The external source is read-only",
                    ),
                    PROTECTED_SOURCE: t(
                      "این منبع محافظت شده است",
                      "This source is protected",
                    ),
                    NO_ACTIVE_LINKS: t(
                      "فایل به کار فعالی پیوند ندارد",
                      "The file has no active task links",
                    ),
                    OPEN_OR_MISSING_TASKS: t(
                      "کار باز یا رابطهٔ نیازمند بررسی وجود دارد",
                      "An open task or unresolved relationship remains",
                    ),
                  } as Record<string, string>
                )[archive.reason] ?? archive.reason}
              </p>
            )}
            {archive.blocked_by.map((id) => (
              <Button
                key={id}
                type="button"
                onClick={() => {
                  setArchive(null);
                  setSelected(null);
                  onOpen(id);
                }}
              >
                {tasks.data?.items.find((task) => task.task_id === id)?.title ??
                  t("بازکردن کار مانع", "Open the blocking task")}
              </Button>
            ))}
            {archive.eligible && (
              <>
                <label className="check-label">
                  <input type="checkbox" required />
                  {t(
                    "با تصمیم خودم بایگانی این فایل را تأیید می‌کنم",
                    "I explicitly approve archiving this file",
                  )}
                </label>
                <Button variant="danger" type="submit">
                  {t("تأیید و بایگانی فایل", "Confirm and archive file")}
                </Button>
              </>
            )}
          </form>
        )}
      </Modal>
      <Modal
        title={t("بررسی بایگانی گروهی", "Review bulk archive")}
        open={!!bulk}
        onOpenChange={(open) => {
          if (
            !open &&
            !bulkBusy &&
            !bulk?.some((row) => row.state === "unconfirmed")
          ) {
            setBulk(null);
            setBulkConfirmed(false);
          }
        }}
      >
        {bulk && (
          <div className="form-grid">
            <p>
              {t(
                "فقط همین فایل‌های مشخص بررسی می‌شوند. بایگانی، اصل و نسخه‌های فایل خصوصی را حفظ می‌کند؛ منابع بیرونی جابه‌جا نمی‌شوند.",
                "Only these exact files are reviewed. Archiving preserves private originals and versions; external sources are not moved.",
              )}
            </p>
            <ul>
              {bulk.map((row) => (
                <li key={row.file_id}>
                  <strong>{row.title}</strong> ·{" "}
                  {
                    (
                      {
                        ready: t("آمادهٔ تأیید", "Ready for approval"),
                        blocked: t("مسدود", "Blocked"),
                        succeeded: t(
                          "بایگانی و خواندن دوباره تأیید شد",
                          "Archive and readback verified",
                        ),
                        failed: t(
                          "رد شده؛ نیازمند بررسی تازه",
                          "Rejected; needs a fresh review",
                        ),
                        unconfirmed: t(
                          "نتیجه هنوز تأیید نشده؛ همان عملیات را دوباره بررسی کن",
                          "Outcome unconfirmed; retry the same intent",
                        ),
                      } as const
                    )[row.state]
                  }
                  {row.message && (
                    <span className="small muted">
                      {" "}
                      ·{" "}
                      {row.message === "EXTERNALLY_MANAGED"
                        ? t(
                            "منبع بیرونی فقط خواندنی است",
                            "External source is read-only",
                          )
                        : row.message === "NO_ACTIVE_LINKS"
                          ? t(
                              "پیوند فعال لازم است",
                              "An active task link is required",
                            )
                          : row.message === "OPEN_OR_MISSING_TASKS"
                            ? t(
                                "کار باز یا رابطهٔ حل‌نشده وجود دارد",
                                "Open task or unresolved relation",
                              )
                            : row.message ===
                                "ARCHIVE_UNCONFIRMED_RETRY_SAME_INTENT"
                              ? t(
                                  "شناسه و تأیید همین عملیات برای تلاش دوباره نگه داشته شده است",
                                  "This exact operation key and approval are retained for recovery",
                                )
                              : row.message}
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p role="status">
              {bulk.filter((row) => row.state === "succeeded").length}/
              {bulk.length}{" "}
              {t("فایل با نتیجهٔ تأییدشده", "files with verified outcomes")}
            </p>
            {bulk.some(
              (row) => row.state === "ready" || row.state === "unconfirmed",
            ) && (
              <>
                <label className="check-label">
                  <input
                    type="checkbox"
                    checked={bulkConfirmed}
                    disabled={bulkBusy}
                    onChange={(event) => setBulkConfirmed(event.target.checked)}
                  />
                  {t(
                    "بایگانی فایل‌های مجاز همین فهرست را با تصمیم خودم تأیید می‌کنم",
                    "I explicitly approve archiving the eligible files in this exact list",
                  )}
                </label>
                <Button
                  variant="danger"
                  disabled={!bulkConfirmed || bulkBusy}
                  onClick={() => void commitBulk()}
                >
                  {bulkBusy
                    ? t("در حال بررسی نتیجه…", "Verifying outcomes…")
                    : bulk.some((row) => row.state === "unconfirmed")
                      ? t(
                          "بررسی دوبارهٔ همان عملیات تأییدنشده",
                          "Recover the same unconfirmed operations",
                        )
                      : t(
                          "تأیید و بایگانی فایل‌های مجاز",
                          "Confirm & archive eligible files",
                        )}
                </Button>
              </>
            )}
            {bulk.some((row) => row.state === "unconfirmed") && (
              <p className="warning">
                {t(
                  "این صفحه را نگه دار تا نتیجهٔ عملیات تأیید شود؛ دریافت نشدن پاسخ به معنی اجرا نشدن بایگانی نیست.",
                  "Keep this page until the operation is reconciled. A missing response does not prove the archive failed.",
                )}
              </p>
            )}
            {!bulkBusy && !bulk.some((row) => row.state === "unconfirmed") && (
              <Button
                onClick={() => {
                  setBulk(null);
                  setBulkConfirmed(false);
                  setSelection({});
                }}
              >
                {t("پایان بررسی", "Finish review")}
              </Button>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
