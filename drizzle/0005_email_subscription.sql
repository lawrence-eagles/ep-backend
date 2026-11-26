CREATE TYPE "public"."waitlist_email_type" AS ENUM('verification', 'welcome', 'launch');--> statement-breakpoint
CREATE TYPE "public"."waitlist_outbox_status" AS ENUM('pending', 'processing', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."waitlist_status" AS ENUM('pending', 'confirmed', 'unsubscribed', 'bounced');--> statement-breakpoint
CREATE TABLE "waitlist_email_outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"subscriber_id" uuid NOT NULL,
	"type" "waitlist_email_type" NOT NULL,
	"payload_encrypted" text NOT NULL,
	"status" "waitlist_outbox_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "waitlist_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"email" text NOT NULL,
	"status" "waitlist_status" DEFAULT 'pending' NOT NULL,
	"verification_token_hash" text,
	"verification_token_expires_at" timestamp with time zone,
	"unsubscribe_token_hash" text,
	"verification_sent_at" timestamp with time zone,
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"source" text,
	"consent_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "waitlist_email_outbox" ADD CONSTRAINT "waitlist_email_outbox_subscriber_id_waitlist_subscribers_id_fk" FOREIGN KEY ("subscriber_id") REFERENCES "public"."waitlist_subscribers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "waitlist_outbox_pending_idx" ON "waitlist_email_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX "waitlist_outbox_subscriber_idx" ON "waitlist_email_outbox" USING btree ("subscriber_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_subscribers_email_unique" ON "waitlist_subscribers" USING btree ("email");--> statement-breakpoint
CREATE INDEX "waitlist_subscribers_status_created_idx" ON "waitlist_subscribers" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "waitlist_subscribers_created_idx" ON "waitlist_subscribers" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "waitlist_subscribers_verification_expiry_idx" ON "waitlist_subscribers" USING btree ("verification_token_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_subscribers_verification_hash_unique" ON "waitlist_subscribers" USING btree ("verification_token_hash") WHERE "waitlist_subscribers"."verification_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_subscribers_unsubscribe_hash_unique" ON "waitlist_subscribers" USING btree ("unsubscribe_token_hash") WHERE "waitlist_subscribers"."unsubscribe_token_hash" IS NOT NULL;