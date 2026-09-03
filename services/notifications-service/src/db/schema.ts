import { pgTable, uuid, varchar, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";

export const subscribers = pgTable("subscribers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  firstName: varchar("first_name", { length: 100 }),
  lastName: varchar("last_name", { length: 100 }),
  isActive: boolean("is_active").notNull().default(true),
  subscribedAt: timestamp("subscribed_at").notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at"),
});

export const blogPosts = pgTable("blog_posts", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  title: varchar("title", { length: 255 }).notNull(),
  category: varchar("category", { length: 100 }).notNull().default("News"),
  readTime: varchar("read_time", { length: 50 }).default("5 min read"),
  author: varchar("author", { length: 150 }).notNull().default("Admin"),
  authorTitle: varchar("author_title", { length: 150 }),
  authorImg: text("author_img"),
  image: text("image"),
  heroImage: text("hero_image"),
  featured: boolean("featured").notNull().default(false),
  isPublished: boolean("is_published").notNull().default(true),
  excerpt: text("excerpt").notNull(),
  keyTakeaways: jsonb("key_takeaways").$type<string[]>().default([]),
  content: jsonb("content").$type<string[]>().default([]),
  tags: jsonb("tags").$type<string[]>().default([]),
  publishedAt: timestamp("published_at").defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});
