import express,{type RequestHandler} from 'express';
import type Database from 'better-sqlite3';
import {CommandExecutor,CommandFoundationError} from '../modules/commands/commandFoundation.js';
import {ExpenseService,ExpenseValidationError} from '../modules/finance/expenseService.js';
import {ExchangeRateValidationError} from '../modules/finance/exchangeRates.js';
import {MoneyValidationError} from '../modules/finance/money.js';

export function createProcurementExpenseRouter(db:Database.Database,authorize:RequestHandler) {
  const router=express.Router(),commands=new CommandExecutor(db),expenses=new ExpenseService(db);
  router.post('/:id/approve-payment',authorize,(req,res)=>{
    try {
      const outcome=commands.execute({operationId:String(req.headers['x-operation-id']||'').trim(),commandType:'finance.procurement-expense.approve-payment.v1',
        payload:{expenseId:req.params.id,payment:req.body},actor:{human:{id:req.user!.id,name:req.user!.username}},
        authorization:{decision:'ALLOW',capability:'finance:write'}},()=>({statusCode:200,
          body:{success:true,data:expenses.approvePayment(req.params.id,req.body)}}));
      return res.status(outcome.result.statusCode).json({...outcome.result.body as object,idempotent:outcome.replayed});
    } catch(error) {
      if(error instanceof ExpenseValidationError||error instanceof CommandFoundationError)
        return res.status(error.statusCode).json({success:false,error:{code:error.code,message:error.message}});
      if(error instanceof ExchangeRateValidationError||error instanceof MoneyValidationError)
        return res.status(400).json({success:false,error:{code:'EXPENSE_PAYMENT_INVALID',message:error.message}});
      throw error;
    }
  });
  return router;
}
