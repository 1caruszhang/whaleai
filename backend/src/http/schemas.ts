import { z } from 'zod';

/** 用户端与运营端共用的手机号 / refresh token 入参形状。 */
export const phoneSchema = z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确');

export const refreshTokenSchema = z.string().min(10, 'refreshToken 不能为空').max(200);

export const passwordSchema = z.string().min(1, '密码不能为空').max(128);
