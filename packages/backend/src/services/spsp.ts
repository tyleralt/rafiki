import Axios from 'axios'
import base64url from 'base64url'
import * as uuid from 'uuid'
import { Middleware } from 'koa'
import { StreamServer } from '@interledger/stream-receiver'
import { AppContainer, AppContext } from '../app'
import { User } from '../models'

export async function makeSPSPHandler(
  container: AppContainer
): Promise<Middleware<unknown, AppContext>> {
  const config = await container.use('config')
  const axios = Axios.create({
    baseURL: config.accountsUrl,
    timeout: 10_000,
    validateStatus: (status) => status === 200 || status === 404
  })
  const server = new StreamServer({
    serverSecret: config.streamSecret,
    serverAddress: config.ilpAddress
  })

  return async function handleSPSP(ctx: AppContext): Promise<void> {
    if (!uuid.validate(ctx.params.id) || uuid.version(ctx.params.id) !== 4) {
      ctx.throw(400, 'Failed to generate credentials: invalid user id')
    }

    if (!ctx.get('accept').includes('application/spsp4+json')) {
      ctx.throw(
        406,
        'Failed to generate credentials: invalid accept: must support application/spsp4+json'
      )
    }

    const nonce = ctx.request.headers['receipt-nonce']
    const secret = ctx.request.headers['receipt-secret']
    if (!nonce !== !secret) {
      ctx.throw(
        400,
        'Failed to generate credentials: receipt nonce and secret must accompany each other'
      )
    }

    const user = await User.query().findById(ctx.params.id)
    const res =
      user &&
      (await axios.get(`/ilp-accounts/${encodeURIComponent(user.accountId)}`))
    if (
      !user ||
      res.status === 404 ||
      (res.status === 200 && res.data['disabled'])
    ) {
      ctx.status = 404
      ctx.set('Content-Type', 'application/spsp4+json')
      ctx.body = JSON.stringify({
        id: 'InvalidReceiverError',
        message: 'Invalid receiver ID'
      })
      return
    }
    if (!res.data['stream']?.enabled) {
      ctx.throw(
        400,
        'Failed to generate credentials: stream is disabled for account'
      )
    }

    try {
      const { ilpAddress, sharedSecret } = server.generateCredentials({
        paymentTag: user.accountId,
        receiptSetup:
          nonce && secret
            ? {
                nonce: Buffer.from(nonce.toString(), 'base64'),
                secret: Buffer.from(secret.toString(), 'base64')
              }
            : undefined,
        asset: res.data['asset']
      })

      ctx.set('Content-Type', 'application/spsp4+json')
      ctx.body = JSON.stringify({
        destination_account: ilpAddress,
        shared_secret: base64url(sharedSecret),
        receipts_enabled: !!(nonce && secret)
      })
    } catch (err) {
      ctx.throw(400, err.message)
    }
  }
}
