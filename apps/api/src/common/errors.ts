import { ArgumentsHost, BadRequestException, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import type { Response } from 'express';
import { z, ZodError, ZodTypeAny } from 'zod';
import { contextStore } from './context';

/** Validates a request body/query with zod; failures become 400 VALIDATION_ERROR. */
export function parse<S extends ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequestException({ code: 'VALIDATION_ERROR', message: 'Invalid input', details: r.error.flatten() });
  }
  return r.data;
}

/** Standard error shape: { code, message, details, traceId }. */
@Catch()
export class ErrorFilter implements ExceptionFilter {
  private readonly log = new Logger('Error');

  catch(err: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const traceId = contextStore.getStore()?.traceId;
    if (err instanceof HttpException) {
      const body = err.getResponse();
      const b = typeof body === 'object' ? (body as Record<string, unknown>) : { message: body };
      return res.status(err.getStatus()).json({
        code: b.code ?? (err.getStatus() === 404 ? 'NOT_FOUND' : 'ERROR'),
        message: b.message ?? err.message,
        details: b.details,
        traceId,
      });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ code: 'VALIDATION_ERROR', message: 'Invalid input', details: err.flatten(), traceId });
    }
    this.log.error(err instanceof Error ? err.stack : String(err), traceId);
    return res.status(500).json({ code: 'INTERNAL_ERROR', message: 'Something went wrong', traceId });
  }
}
