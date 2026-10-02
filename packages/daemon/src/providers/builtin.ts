/**
 * The providers this build ships with.
 *
 * Adding a data source means writing one file and adding one line here. The
 * capability model keeps that promise honest: nothing else in the daemon, the
 * extension or the CLI branches on a connection kind.
 */

import type { Provider } from '@dbrex/core';
import { clickhouseProvider } from './clickhouse';
import { dirProvider } from './dir';
import { elasticsearchProvider } from './elasticsearch';
import { kafkaProvider } from './kafka';
import { mssqlProvider } from './mssql';
import { mysqlProvider } from './mysql';
import { postgresProvider } from './postgres';
import { s3Provider } from './s3';
import { trinoProvider } from './trino';

export function builtinProviders(): Provider[] {
  return [
    mysqlProvider,
    postgresProvider,
    mssqlProvider,
    clickhouseProvider,
    trinoProvider,
    s3Provider,
    kafkaProvider,
    elasticsearchProvider,
    dirProvider,
  ];
}
