import { Command, Component, Head, UiSchema, UiStruct } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { Duration, Effect, Schema } from "effect"

export const UploadStatus = Schema.Literals(["Uploading", "Done", "Cancelled"])
export type UploadStatus = typeof UploadStatus.Type

export const Upload = Schema.Struct({
  id: Schema.Number,
  fileName: Schema.String,
  sizeMegabytes: Schema.Number,
  status: UploadStatus
})
export type Upload = typeof Upload.Type

export const UploadsModel = Schema.Struct({
  uploadId: Schema.Number,
  uploads: Schema.Array(Upload)
})
export type UploadsModel = typeof UploadsModel.Type

const isUploading = (upload: Upload): boolean => upload.status === "Uploading"

// Sets the status of one upload. `UiStruct.evolve` changes one row, and
// returning a function lets `$.evolve` pass it the current uploads.
const withStatus =
  (uploadId: number, status: UploadStatus) =>
  (uploads: ReadonlyArray<Upload>) =>
    uploads.map((upload) =>
      upload.id === uploadId ? UiStruct.evolve(upload, { status }) : upload
    )

export const UploadsMessage = UiSchema.TaggedEnum({
  ClickedStartUpload: {},
  ClickedCancelUpload: { uploadId: Schema.Number },
  ClickedCancelAllUploads: {},
  ClickedRestartUpload: { uploadId: Schema.Number },
  CompletedUploadFile: { uploadId: Schema.Number }
})

export interface FakeFile {
  readonly name: string
  readonly sizeMegabytes: number
}

export const FAKE_FILES: ReadonlyArray<FakeFile> = [
  { name: "vacation-photos.zip", sizeMegabytes: 48 },
  { name: "demo-recording.mp4", sizeMegabytes: 87 },
  { name: "quarterly-report.pdf", sizeMegabytes: 12 },
  { name: "design-assets.sketch", sizeMegabytes: 34 },
  { name: "database-backup.sql", sizeMegabytes: 61 }
]

const MILLISECONDS_PER_MEGABYTE = 100

export class UploadFile extends Command.Service<UploadFile>()(
  "uploads/UploadFile",
  {
    args: { uploadId: Schema.Number, sizeMegabytes: Schema.Number },
    success: UploadsMessage,
    error: Schema.Never,
    group: ["uploadId"],
    mode: "switch"
  }
) {
  static readonly layer = this.toLayer(({ uploadId, sizeMegabytes }) =>
    Effect.sleep(Duration.millis(sizeMegabytes * MILLISECONDS_PER_MEGABYTE))
      .pipe(
        Effect.as(UploadsMessage.CompletedUploadFile({ uploadId }))
      )
  )
}

const BADGE_CLASS: Record<UploadStatus, string> = {
  Uploading: "bg-blue-100 text-blue-700",
  Done: "bg-green-100 text-green-700",
  Cancelled: "bg-gray-200 text-gray-600"
}

const ACTION_BUTTON_CLASS =
  "px-3 py-1 text-sm font-medium rounded-md border transition"

const UploadsDef = Html.component({
  name: "Uploads",
  model: UploadsModel,
  message: UploadsMessage
})

const UploadAction = UploadsDef.fragment((h, upload: Upload) => {
  switch (upload.status) {
    case "Uploading":
      return h.button.on(
        "click",
        UploadsMessage.ClickedCancelUpload({ uploadId: upload.id })
      )
        .attr("aria-label", `Cancel upload ${upload.id}`)
        .class(
          ACTION_BUTTON_CLASS,
          "border-red-300 text-red-600 hover:bg-red-50"
        )
        .children("Cancel")
    case "Cancelled":
      return h.button.on(
        "click",
        UploadsMessage.ClickedRestartUpload({ uploadId: upload.id })
      )
        .attr("aria-label", `Restart upload ${upload.id}`)
        .class(
          ACTION_BUTTON_CLASS,
          "border-blue-300 text-blue-600 hover:bg-blue-50"
        )
        .children("Restart")
    case "Done":
      return null
  }
})

const UploadRow = UploadsDef.fragment((h, upload: Upload) =>
  h.li.key(String(upload.id)).class(
    "p-4 bg-white rounded-lg shadow flex flex-col gap-2"
  ).children(
    h.div.class("flex items-center justify-between gap-3").children(
      h.div.class("flex items-baseline gap-2 min-w-0").children(
        h.span.class("font-medium text-gray-800 truncate").children(
          upload.fileName
        ),
        h.span.class("text-sm text-gray-500 shrink-0").children(
          `${upload.sizeMegabytes} MB`
        )
      ),
      h.div.class("flex items-center gap-3 shrink-0").children(
        h.span.class(
          "px-2 py-0.5 text-xs font-semibold rounded-full",
          BADGE_CLASS[upload.status]
        )
          .children(upload.status),
        UploadAction(h, upload)
      )
    ),
    isUploading(upload) &&
      h.div.class("h-1.5 rounded-full bg-blue-400 animate-pulse")
  )
)

export const UploadsNoDeps = UploadsDef.make({
  init: () => ({ uploadId: 0, uploads: [] }),
  update: {
    ClickedStartUpload: ($) => {
      const file = FAKE_FILES[$.model.uploadId % FAKE_FILES.length]
      const upload: Upload = {
        id: $.model.uploadId,
        fileName: file.name,
        sizeMegabytes: file.sizeMegabytes,
        status: "Uploading"
      }
      return $.set({
        uploadId: $.model.uploadId + 1,
        uploads: [...$.model.uploads, upload]
      }).run(
        UploadFile.make({
          uploadId: upload.id,
          sizeMegabytes: upload.sizeMegabytes
        })
      )
    },

    ClickedCancelUpload: ($, { uploadId }) =>
      $.model.uploads.some((upload) =>
          upload.id === uploadId && isUploading(upload)
        )
        ? $.evolve({ uploads: withStatus(uploadId, "Cancelled") }).run(
          Command.interrupt(UploadFile, { uploadId })
        )
        : $.model,

    ClickedCancelAllUploads: ($) =>
      $.evolve({
        uploads: (uploads) =>
          uploads.map((upload) =>
            isUploading(upload)
              ? UiStruct.evolve(upload, { status: "Cancelled" })
              : upload
          )
      }).run(Command.interrupt(UploadFile)),

    ClickedRestartUpload: ($, { uploadId }) => {
      const upload = $.model.uploads.find((upload) =>
        upload.id === uploadId && upload.status === "Cancelled"
      )
      return upload === undefined
        ? $.model
        : $.evolve({ uploads: withStatus(uploadId, "Uploading") }).run(
          UploadFile.make({ uploadId, sizeMegabytes: upload.sizeMegabytes })
        )
    },

    CompletedUploadFile: ($, { uploadId }) =>
      $.evolve({ uploads: withStatus(uploadId, "Done") })
  },
  head: () => [Head.title("Effect UI Interrupting Commands Example")],
  view: (h, model) =>
    h.div.class("min-h-screen bg-gray-100 py-8").children(
      h.div.class("max-w-lg mx-auto flex flex-col gap-6 px-4").children(
        h.h1.class("text-3xl font-bold text-gray-800 text-center").children(
          "File Uploads"
        ),
        h.div.class("flex justify-center gap-3").children(
          h.button.on("click", UploadsMessage.ClickedStartUpload())
            .class(
              "px-4 py-2 rounded-md bg-blue-500 text-white font-medium hover:bg-blue-600 transition"
            )
            .children("Upload a file"),
          model.uploads.some(isUploading) &&
            h.button.on("click", UploadsMessage.ClickedCancelAllUploads())
              .class(
                "px-4 py-2 rounded-md border border-red-300 text-red-600 font-medium hover:bg-red-50 transition"
              )
              .children("Cancel all")
        ),
        model.uploads.length === 0
          ? h.p.class("text-center text-gray-500").children(
            "Nothing here yet. Start an upload."
          )
          : h.ul.class("flex flex-col gap-3").children(
            model.uploads.map((upload) => UploadRow(h, upload))
          )
      )
    )
})

export const Uploads = UploadsNoDeps.pipe(Component.provide(UploadFile.layer))
