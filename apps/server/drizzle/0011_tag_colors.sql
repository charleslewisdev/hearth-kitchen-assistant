CREATE TYPE "public"."tag_color" AS ENUM('green', 'wheat', 'red', 'blue', 'teal', 'amber', 'plum', 'violet');--> statement-breakpoint
ALTER TABLE "tag" ADD COLUMN "color" "tag_color";