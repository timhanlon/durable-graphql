CREATE TABLE `comments` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`body` text NOT NULL,
	`post_id` integer NOT NULL,
	`author_id` integer NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	CONSTRAINT `fk_comments_post_id_posts_id_fk` FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`),
	CONSTRAINT `fk_comments_author_id_users_id_fk` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `posts` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`published` integer DEFAULT false NOT NULL,
	`author_id` integer NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	CONSTRAINT `fk_posts_author_id_users_id_fk` FOREIGN KEY (`author_id`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL
);
