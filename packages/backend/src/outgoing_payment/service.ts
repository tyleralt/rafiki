import { TransactionOrKnex } from 'objection'
import * as Pay from '@interledger/pay'
import { BaseService } from '../shared/baseService'
import { OutgoingPayment, PaymentIntent, PaymentState } from './model'
import { AccountService } from '../account/service'
import { isAccountError } from '../account/errors'
import { CreditService } from '../credit/service'
import { RatesService } from '../rates/service'
import { IlpPlugin } from './ilp_plugin'
import * as lifecycle from './lifecycle'
import * as worker from './worker'

export interface OutgoingPaymentService {
  get(id: string): Promise<OutgoingPayment | undefined>
  create(options: CreateOutgoingPaymentOptions): Promise<OutgoingPayment>
  approve(id: string): Promise<OutgoingPayment>
  cancel(id: string): Promise<OutgoingPayment>
  requote(id: string): Promise<OutgoingPayment>
  processNext(): Promise<string | undefined>
}

export interface ServiceDependencies extends BaseService {
  knex: TransactionOrKnex
  slippage: number
  quoteLifespan: number // milliseconds
  accountService: AccountService
  creditService: CreditService
  ratesService: RatesService
  makeIlpPlugin: (sourceAccountId: string) => IlpPlugin
}

export async function createOutgoingPaymentService(
  deps_: ServiceDependencies
): Promise<OutgoingPaymentService> {
  const deps = {
    ...deps_,
    logger: deps_.logger.child({ service: 'OutgoingPaymentService' })
  }
  return {
    get: (id) => getOutgoingPayment(deps, id),
    create: (options: CreateOutgoingPaymentOptions) =>
      createOutgoingPayment(deps, options),
    approve: (id) => approvePayment(deps, id),
    cancel: (id) => cancelPayment(deps, id),
    requote: (id) => requotePayment(deps, id),
    processNext: () => worker.processPendingPayment(deps)
  }
}

async function getOutgoingPayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment | undefined> {
  return OutgoingPayment.query(deps.knex).findById(id)
}

type CreateOutgoingPaymentOptions = PaymentIntent & { superAccountId: string }

// TODO ensure this is idempotent/safe for autoApprove:true payments
async function createOutgoingPayment(
  deps: ServiceDependencies,
  options: CreateOutgoingPaymentOptions
): Promise<OutgoingPayment> {
  if (
    options.invoiceUrl &&
    (options.paymentPointer || options.amountToSend !== undefined)
  ) {
    deps.logger.warn(
      {
        options
      },
      'createOutgoingPayment invalid parameters'
    )
    throw new Error(
      'invoiceUrl and (paymentPointer,amountToSend) are mutually exclusive'
    )
  }

  const plugin = deps.makeIlpPlugin(options.superAccountId)
  await plugin.connect()
  const destination = await Pay.setupPayment({
    plugin,
    paymentPointer: options.paymentPointer,
    invoiceUrl: options.invoiceUrl
  }).finally(() => {
    plugin.disconnect().catch((err) => {
      deps.logger.warn({ error: err.message }, 'error disconnecting plugin')
    })
  })

  const sourceAccount = await deps.accountService.create({
    superAccountId: options.superAccountId
  })
  if (isAccountError(sourceAccount)) {
    deps.logger.warn(
      {
        superAccountId: options.superAccountId,
        error: sourceAccount
      },
      'createOutgoingPayment source account creation failed'
    )
    throw new Error('unable to create source account, err=' + sourceAccount)
  }

  return await OutgoingPayment.query(deps.knex).insertAndFetch({
    state: PaymentState.Inactive,
    intent: {
      paymentPointer: options.paymentPointer,
      invoiceUrl: options.invoiceUrl,
      amountToSend: options.amountToSend,
      autoApprove: options.autoApprove
    },
    superAccountId: options.superAccountId,
    sourceAccount: {
      id: sourceAccount.id,
      code: sourceAccount.asset.code,
      scale: sourceAccount.asset.scale
    },
    destinationAccount: {
      scale: destination.destinationAsset.scale,
      code: destination.destinationAsset.code,
      url: destination.accountUrl
    }
  })
}

function requotePayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx).findById(id).forUpdate()
    if (!payment) throw new Error('payment does not exist')
    if (payment.state !== PaymentState.Cancelled) {
      throw new Error(`Cannot quote; payment is in state=${payment.state}`)
    }
    await payment.$query(trx).patch({ state: PaymentState.Inactive })
    return payment
  })
}

async function approvePayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx).findById(id).forUpdate()
    if (!payment) throw new Error('payment does not exist')
    if (payment.state !== PaymentState.Ready) {
      throw new Error(`Cannot approve; payment is in state=${payment.state}`)
    }
    await payment.$query(trx).patch({ state: PaymentState.Activated })
    return payment
  })
}

async function cancelPayment(
  deps: ServiceDependencies,
  id: string
): Promise<OutgoingPayment> {
  return deps.knex.transaction(async (trx) => {
    const payment = await OutgoingPayment.query(trx).findById(id).forUpdate()
    if (!payment) throw new Error('payment does not exist')
    if (payment.state !== PaymentState.Ready) {
      throw new Error(`Cannot cancel; payment is in state=${payment.state}`)
    }
    await payment.$query(trx).patch({
      state: PaymentState.Cancelling,
      error: lifecycle.LifecycleError.CancelledByAPI
    })
    return payment
  })
}