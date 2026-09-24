import {
  GetObjectCommand,
  PutObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";

import { r2, R2_BUCKET_NAME } from "../../../lib/r2";

export interface WriteDeletionToObjectStorageInput {
  deletionId: string;
  userId: string;
  deletedAt: string | Date;
}

export interface DeletionLedgerRecord {
  version: 1;
  event: "user.deleted";
  deletionId: string;
  userId: string;
  deletedAt: string;
}

const DELETION_LEDGER_PREFIX = "deletion-ledger/v1";

/**
 * Converts the deletion timestamp into a normalized UTC ISO string.
 */
function normalizeDeletedAt(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new Error(
      `Invalid deletedAt value received for deletion ledger: ${String(value)}`,
    );
  }

  return date.toISOString();
}

/**
 * Builds a deterministic R2 object key.
 *
 * Example:
 *
 * deletion-ledger/v1/2026/09/24/01995....json
 *
 * Date partitioning makes future disaster-recovery scans more efficient
 * than putting every deletion into a single flat prefix.
 */
function buildDeletionObjectKey(deletionId: string, deletedAt: string): string {
  const date = new Date(deletedAt);

  const year = date.getUTCFullYear().toString().padStart(4, "0");
  const month = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = date.getUTCDate().toString().padStart(2, "0");

  return `${DELETION_LEDGER_PREFIX}/${year}/${month}/${day}/${deletionId}.json`;
}

/**
 * Reads an existing R2 object and verifies that it contains exactly
 * the deletion record we are trying to write.
 *
 * This is important because Inngest retries can happen after the R2
 * write succeeded but before the database outbox was marked processed.
 */
async function verifyExistingDeletionObject(
  key: string,
  expectedRecord: DeletionLedgerRecord,
): Promise<void> {
  const response = await r2.send(
    new GetObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
    }),
  );

  if (!response.Body) {
    throw new Error(
      `R2 returned an existing deletion object without a response body. ` +
        `Bucket=${R2_BUCKET_NAME}, Key=${key}`,
    );
  }

  const body = await response.Body.transformToString();

  let existingRecord: unknown;

  try {
    existingRecord = JSON.parse(body);
  } catch {
    throw new Error(
      `Existing R2 deletion object contains invalid JSON. ` +
        `Bucket=${R2_BUCKET_NAME}, Key=${key}`,
    );
  }

  const expectedJson = JSON.stringify(expectedRecord);
  const existingJson = JSON.stringify(existingRecord);

  if (existingJson !== expectedJson) {
    throw new Error(
      `R2 deletion ledger integrity conflict detected. ` +
        `The object already exists but its contents do not match the ` +
        `deletion event being processed. ` +
        `Bucket=${R2_BUCKET_NAME}, Key=${key}, ` +
        `DeletionId=${expectedRecord.deletionId}`,
    );
  }
}

/**
 * Writes a confirmed account deletion to Cloudflare R2.
 *
 * The operation is intentionally idempotent:
 *
 * 1. The deletion ID determines the object key.
 * 2. The first write uses IfNoneMatch="*" so an existing object cannot
 *    accidentally be overwritten.
 * 3. If the object already exists, its contents are downloaded and
 *    verified against the expected deletion record.
 *
 * This makes the operation safe when Inngest retries after an R2 write
 * succeeded but before the PostgreSQL outbox row was marked processed.
 */
export async function writeDeletionToObjectStorage({
  deletionId,
  userId,
  deletedAt,
}: WriteDeletionToObjectStorageInput): Promise<{
  key: string;
  created: boolean;
}> {
  if (!deletionId || deletionId.trim().length === 0) {
    throw new Error(
      "Cannot write deletion ledger record: deletionId is required.",
    );
  }

  if (!userId || userId.trim().length === 0) {
    throw new Error("Cannot write deletion ledger record: userId is required.");
  }

  const normalizedDeletedAt = normalizeDeletedAt(deletedAt);

  const record: DeletionLedgerRecord = {
    version: 1,
    event: "user.deleted",
    deletionId,
    userId,
    deletedAt: normalizedDeletedAt,
  };

  /**
   * Deterministic JSON serialization.
   *
   * Do not add Date objects directly to the record because we want
   * the exact same representation every time the Inngest function
   * retries.
   */
  const body = JSON.stringify(record);

  /**
   * Content-MD5 gives R2 an integrity check for the uploaded payload.
   */
  const contentMd5 = createHash("md5").update(body, "utf8").digest("base64");

  const key = buildDeletionObjectKey(deletionId, normalizedDeletedAt);

  try {
    await r2.send(
      new PutObjectCommand({
        Bucket: R2_BUCKET_NAME,
        Key: key,

        Body: body,

        ContentType: "application/json; charset=utf-8",

        ContentMD5: contentMd5,

        /**
         * Prevent an existing deletion record from being overwritten.
         *
         * This is important because the deletion ledger should behave
         * as an append-only historical record.
         */
        IfNoneMatch: "*",

        Metadata: {
          "ledger-version": "1",
          "event-type": "user.deleted",
          "deletion-id": deletionId,
        },
      }),
    );

    return {
      key,
      created: true,
    };
  } catch (error: unknown) {
    /**
     * A 412 means the object already exists.
     *
     * That is not automatically an error for us because Inngest may
     * be retrying an operation whose R2 write already succeeded.
     */
    const isPreconditionFailure =
      error instanceof S3ServiceException &&
      error.$metadata.httpStatusCode === 412;

    if (!isPreconditionFailure) {
      throw new Error(
        `Failed to write deletion ledger record to Cloudflare R2. ` +
          `Bucket=${R2_BUCKET_NAME}, Key=${key}, ` +
          `DeletionId=${deletionId}. ` +
          `${error instanceof Error ? error.message : String(error)}`,
        {
          cause: error,
        },
      );
    }

    /**
     * The object already exists.
     *
     * Verify that it is the exact same deletion event instead of
     * blindly treating any existing object as success.
     */
    await verifyExistingDeletionObject(key, record);

    return {
      key,
      created: false,
    };
  }
}
