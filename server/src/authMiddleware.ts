import type { NextFunction, Request, Response } from 'express';
import { currentAuthFromCookie, getAccount } from './authRepo';
import { AppError } from './types';

export function optionalAuth(req: Request, _res: Response, next: NextFunction): void {
  req.auth = currentAuthFromCookie(req.headers.cookie) ?? undefined;
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  req.auth = currentAuthFromCookie(req.headers.cookie) ?? undefined;
  if (!req.auth) throw new AppError(401, 'unauthenticated', 'please sign in');
  next();
}

export function requireNormalAccount(req: Request, _res: Response, next: NextFunction): void {
  if (!req.auth?.userId) throw new AppError(401, 'unauthenticated', 'please sign in');
  const user = getAccount(req.auth.userId);
  if (user.status !== 'normal') throw new AppError(423, 'account_restricted', `account status is ${user.status}`);
  next();
}

export function requireUserId(req: Request): string {
  if (!req.auth?.userId) throw new AppError(401, 'unauthenticated', 'please sign in');
  return req.auth.userId;
}
