import { Ratelimit } from '@upstash/ratelimit';
import { TRPCError } from '@trpc/server';
import { count, eq } from 'drizzle-orm';
import { Redis } from '@upstash/redis';
import { z } from 'zod';

import { waitlist } from '@workspace/db/schema';
import { env } from '@workspace/env/server';
import { db } from '@workspace/db';

import { createTRPCRouter, publicProcedure } from '../trpc';
import { getIp } from '../utils/ip';

let ratelimit: Ratelimit | null = null;

function getRateLimiter() {
  if (!ratelimit) {
    const redis = new Redis({
      url: env.UPSTASH_REDIS_REST_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN,
    });

    ratelimit = new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(2, '1m'),
      analytics: true,
      prefix: 'ratelimit:early-access-waitlist',
    });
  }
  return ratelimit;
}

export const earlyAccessRouter = createTRPCRouter({
  getWaitlistCount: publicProcedure.query(async () => {
    const waitlistCount = await db.select({ count: count() }).from(waitlist);

    if (!waitlistCount[0]) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to get waitlist count',
      });
    }

    return {
      count: waitlistCount[0].count,
    };
  }),
  joinWaitlist: publicProcedure
    .input(
      z.object({
        email: z.string().email(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const limiter = getRateLimiter();
      if (limiter) {
        const ip = getIp(ctx.headers);
        const { success } = await limiter.limit(ip);

        if (!success) {
          throw new TRPCError({
            code: 'TOO_MANY_REQUESTS',
            message: 'Too many requests. Please try again later.',
          });
        }
      }

      const userAlreadyInWaitlist = await db
        .select()
        .from(waitlist)
        .where(eq(waitlist.email, input.email));

      if (userAlreadyInWaitlist[0]) {
        return { message: "You're already on the waitlist!" };
      }

      await db.insert(waitlist).values({
        email: input.email,
      });

      return { message: "You've been added to the waitlist!" };
    }),
});
