-- My addition begins here
-- I added this for postgresql uuid support
CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- My addition ends here

ALTER TABLE "deletion_ledger" ALTER COLUMN "deleted_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deletion_ledger" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "deletion_ledger" DROP COLUMN "confirmed_at";

-- ======================================================
-- My Addition begins here
-- ======================================================
CREATE OR REPLACE FUNCTION record_user_deletion()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_deletion_id uuid;
  v_deleted_at timestamptz;
BEGIN
  /*
   * clock_timestamp() gives the actual PostgreSQL time at the
   * moment the trigger executes rather than the transaction-start
   * timestamp returned by now().
   */
  v_deleted_at := clock_timestamp();

  /*
   * Create the immutable deletion ledger record.
   *
   * This INSERT is part of the same transaction as the DELETE
   * on the Better Auth user table.
   */
  INSERT INTO deletion_ledger (
    deletion_id,
    user_id,
    deleted_at,
    created_at
  )
  VALUES (
    gen_random_uuid(),
    OLD.id,
    v_deleted_at,
    v_deleted_at
  )
  RETURNING deletion_id
  INTO v_deletion_id;

  /*
   * Create the durable outbox record.
   *
   * This is also part of the same transaction.
   */
  INSERT INTO deletion_outbox (
    id,
    deletion_id,
    user_id,
    status,
    attempts,
    created_at
  )
  VALUES (
    gen_random_uuid(),
    v_deletion_id,
    OLD.id,
    'pending',
    0,
    v_deleted_at
  );

  RETURN OLD;
END;
$$;


DROP TRIGGER IF EXISTS user_deletion_ledger_trigger
ON "user";


CREATE TRIGGER user_deletion_ledger_trigger
AFTER DELETE
ON "user"
FOR EACH ROW
EXECUTE FUNCTION record_user_deletion();
-- ======================================================
-- My Addition ends here
-- ======================================================