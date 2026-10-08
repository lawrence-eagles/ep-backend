CREATE TYPE "public"."imagekit_cleanup_status" AS ENUM('pending', 'processing', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "imagekit_cleanup" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" text NOT NULL,
	"user_id" text,
	"status" "imagekit_cleanup_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"claim_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"locked_until" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "image_file_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "imagekit_cleanup_file_id_unique" ON "imagekit_cleanup" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "imagekit_cleanup_status_idx" ON "imagekit_cleanup" USING btree ("status");--> statement-breakpoint
CREATE INDEX "imagekit_cleanup_next_attempt_idx" ON "imagekit_cleanup" USING btree ("next_attempt_at");--> statement-breakpoint
CREATE INDEX "imagekit_cleanup_locked_until_idx" ON "imagekit_cleanup" USING btree ("locked_until");
--> statement-breakpoint

-- ======================================
-- My additional cleanup trigger to delete old records from the imagekit_cleanup table
-- ======================================
CREATE OR REPLACE FUNCTION queue_user_imagekit_cleanup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.image_file_id IS NOT NULL THEN

    INSERT INTO imagekit_cleanup (
      file_id,
      user_id,
      status
    )
    VALUES (
      OLD.image_file_id,
      OLD.id,
      'pending'
    )
    ON CONFLICT (file_id) DO NOTHING;

  END IF;

  RETURN OLD;
END;
$$;

--> statement-breakpoint

DROP TRIGGER IF EXISTS user_imagekit_cleanup_trigger ON "user";
--> statement-breakpoint

CREATE TRIGGER user_imagekit_cleanup_trigger
BEFORE DELETE ON "user"
FOR EACH ROW
EXECUTE FUNCTION queue_user_imagekit_cleanup();
-- ===========================================
-- My Addition ends
-- ===========================================