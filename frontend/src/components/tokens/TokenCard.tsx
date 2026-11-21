'use client';

import type { Token } from '@/hooks/useTokens';
import styles from './TokenCard.module.css';
import { sanitizeUserText } from '@/lib/sanitize';

interface Props {
  token: Token;
}

/** Shortens a Stellar address to `GABC…WXYZ` for compact display. */
function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;
}

/**
 * Groups the integer part and rounds the fraction to `decimals` places, working
 * in BigInt so large fixed-point supplies keep every digit (a JavaScript number
 * cannot hold 999999999999.1234567 exactly).
 */
function formatSupply(value: string, decimals: number | null): string {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return value;
  const [, whole, fraction = ''] = match;
  const places = decimals ?? 7;
  const scale = BigInt(10) ** BigInt(places);
  let units = BigInt(whole + fraction.slice(0, places).padEnd(places, '0'));
  if ((fraction[places] ?? '0') >= '5') units += BigInt(1);

  const grouped = (units / scale).toLocaleString();
  const shown = (units % scale).toString().padStart(places, '0').replace(/0+$/, '');
  const separator = (1.5).toLocaleString().charAt(1);
  return shown ? `${grouped}${separator}${shown}` : grouped;
}

export function TokenCard({ token }: Props) {
  return (
    <article className={styles.card}>
      <div className={styles.header}>
        <span className={styles.code}>{token.asset_code}</span>
        {token.name && <span className={styles.name}>{sanitizeUserText(token.name)}</span>}
      </div>

      {token.description && (
        <p className={styles.description}>{sanitizeUserText(token.description)}</p>
      )}

      <div className={styles.supply}>
        <span className={styles.supplyValue}>
          {formatSupply(token.total_supply, token.decimals)}
        </span>
        <span className={styles.supplyLabel}>total supply</span>
      </div>

      <dl className={styles.meta}>
        <div className={styles.metaRow}>
          <dt>Issuer</dt>
          <dd title={token.asset_issuer}>{shortAddress(token.asset_issuer)}</dd>
        </div>
        <div className={styles.metaRow}>
          <dt>Distributor</dt>
          <dd title={token.distributor_address}>{shortAddress(token.distributor_address)}</dd>
        </div>
      </dl>
    </article>
  );
}
