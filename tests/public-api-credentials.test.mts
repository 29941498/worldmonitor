import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  publicApiCredentials,
  resolvePublicApiCredentials,
} from '../src/services/public-api-credentials.ts';

describe('self-hosted public API credentials', () => {
  it('keeps the default hosted and node-test behavior credential-less', () => {
    assert.equal(publicApiCredentials('/api/bootstrap?public=1'), 'omit');
    assert.equal(
      resolvePublicApiCredentials('/api/bootstrap?public=1', {
        gatewayAuth: false,
        appOrigin: 'https://worldmonitor.app',
      }),
      'omit',
    );
  });

  it('includes cookies only for same-origin API reads in a gateway build', () => {
    const context = { gatewayAuth: true, appOrigin: 'https://private.example' };
    assert.equal(resolvePublicApiCredentials('/api/bootstrap?public=1', context), 'include');
    assert.equal(
      resolvePublicApiCredentials('https://private.example/api/news/v1/list-feed-digest', context),
      'include',
    );
    assert.equal(resolvePublicApiCredentials('/assets/main.js', context), 'omit');
    assert.equal(
      resolvePublicApiCredentials('https://api.worldmonitor.app/api/bootstrap?public=1', context),
      'omit',
    );
  });
});
