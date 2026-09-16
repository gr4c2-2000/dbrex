/**
 * The providers this build ships with.
 *
 * Adding a data source means writing one file and adding one line here. The
 * capability model keeps that promise honest: nothing else in the daemon, the
 * extension or the CLI branches on a connection kind.
 */

import type { Provider } from '@dbrex/core';
import { clickhouseProvider } from './clickhouse';
import { mysqlProvider } from './mysql';
import { s3Provider } from './s3';
import { trinoProvider } from './trino';

export function builtinProviders(): Provider[] {
  return [mysqlProvider, clickhouseProvider, trinoProvider, s3Provider];
}
